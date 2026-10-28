import {
  encodeFunctionData,
  formatEther,
  isAddressEqual,
  parseEther,
  parseUnits,
  type Address,
} from 'viem';
import type { TicketLeg, TradeTicket } from '../../../shared/panel';
import { sanitizeLabel } from '../../../shared/sanitize';
import { effectivePreset } from '../../../shared/settings/defaults';
import type { WalletAccount } from '../../../shared/wallet';
import { erc20Abi } from '../../chain/abis';
import { staticGas } from '../fees';
import type { Routed } from '../routing';
import type { TxDraft } from '../types';
import { type EngineCore, type EngineDeps, TradeError } from './core';

/** Moves native or tokens from the popup: send, distribute and collect. */
export class TransferFlow {
  private readonly d: EngineDeps;

  constructor(private readonly core: EngineCore) {
    this.d = core.d;
  }

  /** Fee estimate and the most that can be sent, for the Send form's Max. */
  async sendPrep(req: {
    chainId: number;
    walletId: string;
    token?: Address | undefined;
  }): Promise<{ feeWei: string; maxAmount: string }> {
    const { chain, cs, ctx } = await this.core.context(req.chainId);
    const [w] = await this.core.wallets([req.walletId]);
    const wallet = w as WalletAccount;
    const fees = await this.d.fees.fees(chain, ctx.client, effectivePreset(cs), this.d.now());
    const gas = staticGas(chain, req.token ? 'tokenTransfer' : 'transfer');
    const feeWei = gas * fees.maxFeePerGas;
    if (req.token) {
      const bal = await ctx.client.readContract({
        address: req.token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [wallet.address],
      });
      return { feeWei: feeWei.toString(), maxAmount: bal.toString() };
    }
    const bal = await ctx.client.getBalance({ address: wallet.address });
    // Leave 2x the fee so a base-fee rise between now and sending cannot strand it.
    const max = bal - feeWei * 2n;
    return { feeWei: feeWei.toString(), maxAmount: (max > 0n ? max : 0n).toString() };
  }

  /** Facts about a typed recipient, shown as checks in the Send form. */
  async checkRecipient(
    req: { chainId: number; to: Address },
    history: readonly TradeTicket[],
  ): Promise<{
    ownName: string | null;
    contract: boolean;
    tokenSymbol: string | null;
    sentBefore: boolean;
  }> {
    const { ctx } = await this.core.context(req.chainId);
    const own = (await this.d.vault.listAccounts()).find((a) => isAddressEqual(a.address, req.to));
    const code = await ctx.client.getCode({ address: req.to }).catch(() => undefined);
    // EIP-7702 delegation (0xef0100 + address) is still a key-held account, not a contract.
    const contract = !!code && code !== '0x' && !code.toLowerCase().startsWith('0xef0100');
    // A token contract answers symbol(); sending to it almost always loses the funds.
    const tokenSymbol = contract
      ? await ctx.client
          .readContract({ address: req.to, abi: erc20Abi, functionName: 'symbol' })
          .then((x) => sanitizeLabel(x, 16) || 'token')
          .catch(() => null)
      : null;
    const sentBefore = history.some(
      (t) =>
        t.kind === 'send' &&
        t.status === 'done' &&
        !!t.recipient &&
        isAddressEqual(t.recipient, req.to),
    );
    return { ownName: own?.name ?? null, contract, tokenSymbol, sentBefore };
  }

  /**
   * Sends native or an ERC-20 to an outside address typed in the popup. Not reachable
   * from the trading panel. Above the confirmation threshold (or when the value is
   * unknown) the password is required again.
   */
  async send(req: {
    chainId: number;
    walletId: string;
    to: Address;
    token?: Address | undefined;
    amount: string;
    password?: string | undefined;
  }): Promise<TradeTicket> {
    const startedAt = this.d.now();
    const { chain, cs, gs, ctx } = await this.core.context(req.chainId);
    const [w] = await this.core.wallets([req.walletId]);
    const wallet = w as WalletAccount;
    const nativeUsd = await this.d.prices.nativeUsd(ctx).catch(() => null);

    let value: bigint;
    let usd: number | null;
    let decimals: number | undefined;
    if (req.token) {
      const d = await this.core.decimalsOf(ctx, req.token);
      if (d === null) throw new TradeError('not_found', 'Not a token on this chain.');
      decimals = d;
      value = parseUnits(req.amount, d);
      const [route] = await this.d.routing
        .best(ctx, req.token, 'sell', [value])
        .catch(() => [] as Routed[]);
      usd = route && nativeUsd !== null ? Number(formatEther(route.out)) * nativeUsd : null;
    } else {
      value = parseEther(req.amount);
      usd = nativeUsd !== null ? Number(formatEther(value)) * nativeUsd : null;
    }
    if (value <= 0n) throw new TradeError('insufficient_funds', 'Amount too small.');

    if (usd === null || usd > gs.confirmAboveUsd) {
      if (!req.password)
        throw new TradeError('needs_password', usd === null ? '' : `${usd.toFixed(2)}`);
      await this.d.vault.verifyPassword(req.password);
    }

    const fees = await this.d.fees.fees(chain, ctx.client, effectivePreset(cs), this.d.now());
    const nativeBal = await ctx.client.getBalance({ address: wallet.address });
    const feeReserve =
      staticGas(chain, req.token ? 'tokenTransfer' : 'transfer') * fees.maxFeePerGas;
    if (req.token) {
      const bal = await ctx.client.readContract({
        address: req.token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [wallet.address],
      });
      if (bal < value) throw new TradeError('insufficient_funds', 'Not enough tokens.');
      if (nativeBal < feeReserve)
        throw new TradeError(
          'insufficient_funds',
          `Not enough ${chain.nativeCurrency.symbol} for the fee.`,
        );
    } else if (nativeBal < value + feeReserve) {
      throw new TradeError('insufficient_funds', 'Amount plus fee is more than the balance.');
    }

    const symbol = req.token ? await this.core.symbolOf(ctx, req.token) : undefined;
    const st = this.core.newTicket(
      'send',
      chain,
      [
        {
          walletId: wallet.id,
          walletName: wallet.name,
          kind: 'transfer',
          status: 'queued',
          amountIn: value.toString(),
        },
      ],
      undefined,
      req.token,
      symbol,
    );
    st.startedAt = startedAt;
    st.ticket.recipient = req.to;
    if (decimals !== undefined) st.ticket.decimals = decimals;
    if (nativeUsd !== null) st.ticket.nativeUsd = nativeUsd;

    const own = (await this.d.vault.listAccounts()).map((a) => a.address);
    const tx: TxDraft = req.token
      ? {
          to: req.token,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'transfer',
            args: [req.to, value],
          }),
          value: 0n,
        }
      : { to: req.to, data: '0x', value };
    const vctx = this.core.validationCtx(chain, wallet.address, own, {
      maxValue: req.token ? 0n : value,
      token: req.token,
      payee: req.to,
    });
    void this.core.execute(st, 0, {
      chain,
      cs,
      gs,
      wallet,
      tx,
      vctx,
      kind: req.token ? 'tokenTransfer' : 'transfer',
      // Catches tokens that cannot be moved (paused, blacklisted) before signing.
      simulate: true,
    });
    this.core.update(st);
    return structuredClone(st.ticket);
  }

  async distribute(req: {
    chainId: number;
    hubId: string;
    walletIds: string[];
    amountEach: string;
  }): Promise<TradeTicket> {
    const { chain, cs, gs, ctx } = await this.core.context(req.chainId);
    const all = await this.d.vault.listAccounts();
    const hub = all.find((a) => a.id === req.hubId);
    if (!hub) throw new TradeError('not_found');
    const targets = (await this.core.wallets(req.walletIds)).filter((w) => w.id !== hub.id);
    const each = parseEther(req.amountEach);
    const nativeUsd = await this.d.prices.nativeUsd(ctx);
    if (nativeUsd === null)
      throw new TradeError('limit_exceeded', 'USD price unavailable, cannot check limits.');
    const totalUsd = Number(formatEther(each * BigInt(targets.length))) * nativeUsd;
    if (Number(formatEther(each)) * nativeUsd > gs.maxUsdPerTx)
      throw new TradeError('limit_exceeded', 'Per-transfer amount above your limit.');
    if (totalUsd > gs.maxUsdPerClick)
      throw new TradeError('limit_exceeded', 'Total above your per-click limit.');

    const legs: TicketLeg[] = targets.map((w) => ({
      walletId: hub.id,
      walletName: `${hub.name} → ${w.name}`,
      kind: 'transfer',
      status: 'queued',
      amountIn: each.toString(),
    }));
    const st = this.core.newTicket('distribute', chain, legs);
    const own = all.map((a) => a.address);
    const maxValue = this.core.usdToWei(gs.maxUsdPerTx, nativeUsd);
    void (async () => {
      for (let i = 0; i < targets.length; i++) {
        const to = (targets[i] as WalletAccount).address;
        const vctx = this.core.validationCtx(chain, hub.address, own, { maxValue });
        await this.core.execute(st, i, {
          chain,
          cs,
          gs,
          wallet: hub,
          tx: { to, data: '0x', value: each },
          vctx,
          kind: 'transfer',
          simulate: false,
        });
      }
    })();
    this.core.update(st);
    return structuredClone(st.ticket);
  }

  async collect(req: {
    chainId: number;
    hubId: string;
    walletIds: string[];
  }): Promise<TradeTicket> {
    const { chain, cs, gs, ctx } = await this.core.context(req.chainId);
    const all = await this.d.vault.listAccounts();
    const hub = all.find((a) => a.id === req.hubId);
    if (!hub) throw new TradeError('not_found');
    const sources = (await this.core.wallets(req.walletIds)).filter((w) => w.id !== hub.id);
    const own = all.map((a) => a.address);
    const preset = effectivePreset(cs);
    const fees = await this.d.fees.fees(chain, ctx.client, preset, this.d.now());
    const gas = staticGas(chain, 'transfer');
    const legs: TicketLeg[] = sources.map((w) => ({
      walletId: w.id,
      walletName: `${w.name} → ${hub.name}`,
      kind: 'transfer',
      status: 'queued',
    }));
    const st = this.core.newTicket('collect', chain, legs);
    void (async () => {
      for (let i = 0; i < sources.length; i++) {
        const w = sources[i] as WalletAccount;
        const leg = st.ticket.legs[i] as TicketLeg;
        const bal = await ctx.client.getBalance({ address: w.address }).catch(() => 0n);
        // Keep 2x the max gas cost so a base-fee spike cannot make the transfer fail.
        const value = bal - gas * fees.maxFeePerGas * 2n;
        if (value <= 0n) {
          leg.status = 'skipped';
          leg.error = 'Nothing to collect';
          this.core.update(st);
          continue;
        }
        leg.amountIn = value.toString();
        // Collecting into one of your own wallets is not capped by the USD limit.
        const vctx = this.core.validationCtx(chain, w.address, own, { maxValue: value });
        await this.core.execute(st, i, {
          chain,
          cs,
          gs,
          wallet: w,
          tx: { to: hub.address, data: '0x', value },
          vctx,
          kind: 'transfer',
          simulate: false,
        });
      }
    })();
    this.core.update(st);
    return structuredClone(st.ticket);
  }
}
