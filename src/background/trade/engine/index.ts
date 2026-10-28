import { BridgeFlow } from './bridge';
import { EngineCore, type EngineDeps } from './core';
import { TradingFlow } from './trading';
import { TransferFlow } from './transfers';

export { TradeError, chainContext, gasFeeRefusal, shortErr, type EngineDeps } from './core';
export { approvalTarget, minOutAfter } from './trading';

/**
 * The trading engine: one core (context, tickets, validate → simulate → sign → send,
 * receipts) shared by the flows that build the transactions.
 */
export class TradeEngine {
  private readonly core: EngineCore;
  private readonly trading: TradingFlow;
  private readonly transfers: TransferFlow;
  private readonly bridging: BridgeFlow;

  constructor(d: EngineDeps) {
    this.core = new EngineCore(d);
    this.trading = new TradingFlow(this.core);
    this.transfers = new TransferFlow(this.core);
    this.bridging = new BridgeFlow(this.core);
  }

  buy(...a: Parameters<TradingFlow['buy']>) {
    return this.trading.buy(...a);
  }

  sell(...a: Parameters<TradingFlow['sell']>) {
    return this.trading.sell(...a);
  }

  sendPrep(...a: Parameters<TransferFlow['sendPrep']>) {
    return this.transfers.sendPrep(...a);
  }

  checkRecipient(...a: Parameters<TransferFlow['checkRecipient']>) {
    return this.transfers.checkRecipient(...a);
  }

  send(...a: Parameters<TransferFlow['send']>) {
    return this.transfers.send(...a);
  }

  distribute(...a: Parameters<TransferFlow['distribute']>) {
    return this.transfers.distribute(...a);
  }

  collect(...a: Parameters<TransferFlow['collect']>) {
    return this.transfers.collect(...a);
  }

  bridgeQuote(...a: Parameters<BridgeFlow['bridgeQuote']>) {
    return this.bridging.bridgeQuote(...a);
  }

  bridge(...a: Parameters<BridgeFlow['bridge']>) {
    return this.bridging.bridge(...a);
  }

  /** Speeds up or cancels a wallet's pending transaction in a ticket. */
  replace(...a: Parameters<EngineCore['replace']>) {
    return this.core.replace(...a);
  }

  warm(...a: Parameters<EngineCore['warm']>) {
    return this.core.warm(...a);
  }
}
