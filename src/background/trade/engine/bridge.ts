import { formatEther, parseEther } from 'viem';
import { getChain } from '../../../shared/chains';
import type { TicketLeg, TradeTicket } from '../../../shared/panel';
import { RELAY_DEPOSITORY, relayRule } from '../relay';
import { type EngineCore, type EngineDeps, type TicketState, TradeError, sleep } from './core';

/** Bridges native between chains through Relay, then follows the payout. */
export class BridgeFlow {
  private readonly d: EngineDeps;

  constructor(private readonly core: EngineCore) {
    this.d = core.d;
  }

  private async bridgeWallets(fromWalletId: string, toWalletId: string) {
    const all = await this.d.vault.listAccounts();
    const from = all.find((a) => a.id === fromWalletId);
    const to = all.find((a) => a.id === toWalletId);
    if (!from || !to) throw new TradeError('not_found', 'Wallet not found.');
    return { from, to, own: all.map((a) => a.address) };
  }

  async bridgeQuote(req: {
    fromChainId: number;
    toChainId: number;
    amount: string;
    fromWalletId: string;
    toWalletId: string;
  }): Promise<{
    amountOut: string;
    feeUsd: number | null;
    timeEstimateS: number | null;
    amountInUsd: number | null;
  }> {
    if (req.fromChainId === req.toChainId)
      throw new TradeError('unsupported_chain', 'Pick two different chains.');
    const { ctx } = await this.core.context(req.fromChainId);
    const { from, to } = await this.bridgeWallets(req.fromWalletId, req.toWalletId);
    const amount = parseEther(req.amount);
    const [q, nativeUsd] = await Promise.all([
      this.d.relay
        .quote({
          user: from.address,
          recipient: to.address,
          fromChainId: req.fromChainId,
          toChainId: req.toChainId,
          amount,
        })
        .catch((e: unknown) => {
          throw new TradeError('no_route', e instanceof Error ? e.message : undefined);
        }),
      this.d.prices.nativeUsd(ctx).catch(() => null),
    ]);
    return {
      amountOut: q.amountOut.toString(),
      feeUsd: q.feeUsd,
      timeEstimateS: q.timeEstimateS,
      amountInUsd: nativeUsd !== null ? Number(formatEther(amount)) * nativeUsd : null,
    };
  }

  async bridge(req: {
    fromChainId: number;
    toChainId: number;
    amount: string;
    fromWalletId: string;
    toWalletId: string;
    confirmed: boolean;
  }): Promise<TradeTicket> {
    if (req.fromChainId === req.toChainId)
      throw new TradeError('unsupported_chain', 'Pick two different chains.');
    const { chain, cs, gs, ctx } = await this.core.context(req.fromChainId);
    if (!getChain(req.toChainId)) throw new TradeError('unsupported_chain');
    const { from, to, own } = await this.bridgeWallets(req.fromWalletId, req.toWalletId);
    const amount = parseEther(req.amount);
    if (amount <= 0n) throw new TradeError('insufficient_funds', 'Amount too small.');

    const nativeUsd = await this.d.prices.nativeUsd(ctx);
    if (nativeUsd === null)
      throw new TradeError('limit_exceeded', 'USD price unavailable, cannot check limits.');
    const usd = Number(formatEther(amount)) * nativeUsd;
    if (usd > gs.maxUsdPerTx)
      throw new TradeError(
        'limit_exceeded',
        `${usd.toFixed(2)} > ${gs.maxUsdPerTx} per transaction.`,
      );
    if (usd > gs.confirmAboveUsd && !req.confirmed)
      throw new TradeError('needs_confirmation', `${usd.toFixed(2)}`);

    // Always a fresh quote right before signing; checkQuote() pins the shape.
    const q = await this.d.relay
      .quote({
        user: from.address,
        recipient: to.address,
        fromChainId: req.fromChainId,
        toChainId: req.toChainId,
        amount,
      })
      .catch((e: unknown) => {
        throw new TradeError('no_route', e instanceof Error ? e.message : undefined);
      });

    const legs: TicketLeg[] = [
      {
        walletId: from.id,
        walletName: from.name,
        kind: 'bridge',
        status: 'queued',
        amountIn: amount.toString(),
      },
    ];
    const st = this.core.newTicket('bridge', chain, legs);
    st.ticket.bridge = {
      toChainId: req.toChainId,
      amountIn: amount.toString(),
      amountOut: q.amountOut.toString(),
      recipientName: to.name,
      requestId: q.requestId,
      relayStatus: 'waiting',
    };
    const vctx = this.core.validationCtx(chain, from.address, own, {
      maxValue: this.core.usdToWei(gs.maxUsdPerTx, nativeUsd),
      extraContracts: new Map([
        ...this.d.extraContracts(chain.id),
        [RELAY_DEPOSITORY.toLowerCase(), relayRule],
      ]),
    });
    void (async () => {
      const ok = await this.core.execute(st, 0, {
        chain,
        cs,
        gs,
        wallet: from,
        tx: q.tx,
        vctx,
        kind: 'deposit',
        // A contract call quoted by an outside API: always measured, never a static guess.
        simulate: true,
      });
      if (ok) await this.trackBridge(st, q.statusPath);
    })();
    this.core.update(st);
    return structuredClone(st.ticket);
  }

  /** Polls Relay until the destination side is filled, refunded or failed. */
  private async trackBridge(st: TicketState, statusPath: string): Promise<void> {
    const started = this.d.now();
    while (this.d.now() - started < 15 * 60_000) {
      await sleep(3_000);
      const r = await this.d.relay.status(statusPath).catch(() => null);
      if (!r || !st.ticket.bridge) continue;
      const changed =
        r.status !== st.ticket.bridge.relayStatus ||
        (r.outHash && r.outHash !== st.ticket.bridge.outHash);
      st.ticket.bridge.relayStatus = r.status;
      if (r.outHash) st.ticket.bridge.outHash = r.outHash;
      if (changed) this.core.update(st);
      if (['success', 'failure', 'refund'].includes(r.status)) return;
    }
  }
}
