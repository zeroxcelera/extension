import { parseAbi } from 'viem';

export const erc20Abi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);

/**
 * Only the two calls a wallet makes on a token. Decoding against this (not erc20Abi) means
 * anything else, transferFrom included, fails to decode and is refused.
 */
export const erc20WriteAbi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);

/** Some old tokens return bytes32 for name/symbol. */
export const erc20Bytes32Abi = parseAbi([
  'function name() view returns (bytes32)',
  'function symbol() view returns (bytes32)',
]);

export const pairAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]);

export const multicall3Abi = parseAbi(['function getEthBalance(address) view returns (uint256)']);
