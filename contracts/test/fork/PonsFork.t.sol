// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CeleraRouter} from "../../src/CeleraRouter.sol";
import {ForkBase, IERC20} from "./ForkBase.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPonsCurve {
    function graduated() external view returns (bool);
    function isNativeQuote() external view returns (bool);
    function pairToken() external view returns (address);
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256);
    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) external returns (uint256);
}

/// @notice Robinhood Chain fork: a Pons curve quoted in USDG, bought with ether and sold back
///         to ether in ONE transaction each through the router. The ether ↔ USDG leg uses
///         the Uniswap Universal Router with its own "whole balance" amounts, so it needs no
///         balance injection.
contract PonsForkTest is ForkBase {
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant UNIVERSAL_ROUTER = 0x204FAca1764B154221e35c0d20aBb3c525710498;
    address constant TOKEN = 0x227642e8A9dFb94873EeE4e316af9cE06659FCEd; // NOODS
    address constant CURVE = 0xA61E57E11e7a1765925aA1532073caAc52567c87;

    // Universal Router commands and constants.
    bytes1 constant V3_SWAP_EXACT_IN = 0x00;
    bytes1 constant WRAP_ETH = 0x0b;
    bytes1 constant UNWRAP_WETH = 0x0c;
    address constant UR_MSG_SENDER = address(1);
    address constant UR_ADDRESS_THIS = address(2);
    uint256 constant CONTRACT_BALANCE = 1 << 255;

    function setUp() public {
        _setUpFork("ROBINHOOD_RPC_URL", "https://rpc.mainnet.chain.robinhood.com");
    }

    function _onCurve() internal view returns (bool) {
        assertFalse(IPonsCurve(CURVE).isNativeQuote());
        assertEq(IPonsCurve(CURVE).pairToken(), USDG);
        return !IPonsCurve(CURVE).graduated();
    }

    /// Ether → USDG (Uniswap v3 0.01%), paid to the caller (our router).
    function _etherToUsdg() internal view returns (CeleraRouter.Call memory) {
        bytes[] memory inputs = new bytes[](2);
        inputs[0] = abi.encode(UR_ADDRESS_THIS, CONTRACT_BALANCE);
        inputs[1] =
            abi.encode(UR_MSG_SENDER, CONTRACT_BALANCE, uint256(1), abi.encodePacked(WETH, uint24(100), USDG), false);
        return _call(
            UNIVERSAL_ROUTER,
            type(uint256).max,
            abi.encodeCall(
                IUniversalRouter.execute, (abi.encodePacked(WRAP_ETH, V3_SWAP_EXACT_IN), inputs, block.timestamp)
            )
        );
    }

    /// USDG already sent to the Universal Router → ether, paid to the caller (our router).
    function _usdgToEther() internal view returns (CeleraRouter.Call memory) {
        bytes[] memory inputs = new bytes[](2);
        inputs[0] =
            abi.encode(UR_ADDRESS_THIS, CONTRACT_BALANCE, uint256(1), abi.encodePacked(USDG, uint24(100), WETH), false);
        inputs[1] = abi.encode(UR_MSG_SENDER, uint256(1));
        return _call(
            UNIVERSAL_ROUTER,
            0,
            abi.encodeCall(
                IUniversalRouter.execute, (abi.encodePacked(V3_SWAP_EXACT_IN, UNWRAP_WETH), inputs, block.timestamp)
            )
        );
    }

    function test_buyAndSellUsdgQuotedPonsCurve() public {
        vm.skip(!_onCurve());

        // Ether → USDG → curve buy with all of it (the curve may pull it), tokens to the user.
        CeleraRouter.Call[] memory buy = new CeleraRouter.Call[](2);
        buy[0] = _etherToUsdg();
        buy[1] = _spend(CURVE, abi.encodeCall(IPonsCurve.buy, (0, 1, user)), USDG, 4, CURVE);

        CeleraRouter.Input memory none;
        vm.prank(user);
        uint256 bought = router.execute{value: 0.005 ether}(buy, none, TOKEN, 1, _list(USDG, WETH), block.timestamp);
        assertGt(bought, 0);
        assertEq(IERC20(TOKEN).balanceOf(user), bought);
        _assertRouterEmpty(_list(TOKEN, USDG, WETH));
        _assertNoAllowance(USDG, CURVE);

        // Sell: Permit2 pull → curve sell to USDG (paid to the router) → USDG → ether.
        _approvePermit2(TOKEN);
        CeleraRouter.Call[] memory sell = new CeleraRouter.Call[](3);
        sell[0] = _spend(CURVE, abi.encodeCall(IPonsCurve.sell, (0, 1, address(router))), TOKEN, 4, CURVE);
        sell[1] = _inject(USDG, abi.encodeCall(IERC20.transfer, (UNIVERSAL_ROUTER, 0)), USDG, 36);
        sell[2] = _usdgToEther();
        CeleraRouter.Input memory input = _permit(TOKEN, bought);
        uint256 before = user.balance;
        vm.prank(user);
        uint256 out = router.execute(sell, input, NATIVE, 1, _list(TOKEN, USDG, WETH), block.timestamp);
        assertEq(user.balance - before, out);
        assertEq(IERC20(TOKEN).balanceOf(user), 0, "token not sold");
        _assertRouterEmpty(_list(TOKEN, USDG, WETH));
        _assertNoAllowance(TOKEN, CURVE);
        // Curve fee + creator tax (3% each way) + pool fees + price impact.
        assertGt(out, 0.0045 ether, "round trip lost too much");
    }
}
