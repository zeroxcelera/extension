import type { Address } from 'viem';

export interface UniswapDeployment {
  universalRouter: Address;
  v2Factory: Address;
  v3Factory: Address;
  v3QuoterV2: Address;
  v4PoolManager: Address;
  v4PositionManager: Address;
  v4StateView: Address;
  v4Quoter: Address;
}

export const PERMIT2: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

/**
 * From Uniswap's official deployments.json (generated 2026-10-16, Uniswap/contracts
 * @cd2e8a8). Universal Router is v2.1.2 (commit 802fe4c) on every chain, so the
 * command encoding below matches all four.
 */
export const UNISWAP: Record<number, UniswapDeployment> = {
  1: {
    universalRouter: '0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85',
    v2Factory: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
    v3Factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    v3QuoterV2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    v4PoolManager: '0x000000000004444c5dc75cB358380D2e3dE08A90',
    v4PositionManager: '0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e',
    v4StateView: '0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227',
    v4Quoter: '0x99bd42B2B22e531f283b7F8a86dFf631EB16A9D1',
  },
  8453: {
    universalRouter: '0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40',
    v2Factory: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6',
    v3Factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    v3QuoterV2: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
    v4PoolManager: '0x498581fF718922c3f8e6A244956aF099B2652b2b',
    v4PositionManager: '0x7C5f5A4bBd8fD63184577525326123B519429bDc',
    v4StateView: '0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71',
    v4Quoter: '0xE1A6C5803e3c44368b171BD680c7D32dfc92CA47',
  },
  56: {
    universalRouter: '0xDc264714F68d84CF29BC605589405E78bDBE7C9f',
    v2Factory: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6',
    v3Factory: '0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7',
    v3QuoterV2: '0x78D78E420Da98ad378D7799bE8f4AF69033EB077',
    v4PoolManager: '0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF',
    v4PositionManager: '0x7A4a5c919aE2541AeD11041A1AEeE68f1287f95b',
    v4StateView: '0xd13Dd3D6E93f276FAfc9Db9E6BB47C1180aeE0c4',
    v4Quoter: '0x95C086d7fE28AdD842ee220fef225a777474d781',
  },
  4663: {
    universalRouter: '0x204FAca1764B154221e35c0d20aBb3c525710498',
    v2Factory: '0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f',
    v3Factory: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA',
    v3QuoterV2: '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7',
    v4PoolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
    v4PositionManager: '0x58daec3116aae6D93017bAAea7749052E8a04fA7',
    v4StateView: '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b',
    v4Quoter: '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94',
  },
  // Arbitrum One: added purely as config to prove a new chain needs no code changes.
  42161: {
    universalRouter: '0x2d01411773c8C24805306E89A41F7855C3c4Fe65',
    v2Factory: '0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9',
    v3Factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    v3QuoterV2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    v4PoolManager: '0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32',
    v4PositionManager: '0xd88F38F930b7952f2DB2432Cb002E7abbF3dD869',
    v4StateView: '0x76Fd297e2D437cd7f76d50F01AfE6160f86e9990',
    v4Quoter: '0x8928074CA1b241D8Ec02815881c1Af11E8bC5219',
  },
};
