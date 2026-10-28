// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CeleraRouter} from "../../src/CeleraRouter.sol";
import {ForkBase, IERC20} from "./ForkBase.sol";

interface IPancakeV2Router {
    function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external
        payable
        returns (uint256[] memory);
    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory);
}

interface IFlapPortal {
    struct ExactInputParams {
        address inputToken;
        address outputToken;
        uint256 inputAmount;
        uint256 minOutputAmount;
        bytes permitData;
    }

    function swapExactInput(ExactInputParams calldata params) external payable returns (uint256);
    function getTokenV3(address token)
        external
        view
        returns (
            uint8 status,
            uint256 reserve,
            uint256 circulatingSupply,
            uint256 price,
            uint8 tokenVersion,
            uint256 r,
            uint256 dexSupplyThresh,
            address quoteToken,
            bool nativeToQuoteSwapEnabled
        );
}

interface IFourHelper {
    function buyWithEth(uint256 origin, address token, address to, uint256 funds, uint256 minAmount) external payable;
    function sellForEth(
        uint256 origin,
        address token,
        uint256 amount,
        uint256 minFunds,
        uint256 feeRate,
        address feeRecipient
    ) external;
    function getTokenInfo(address token)
        external
        view
        returns (
            uint256 version,
            address tokenManager,
            address quote,
            uint256 lastPrice,
            uint256 tradingFeeRate,
            uint256 minTradingFee,
            uint256 launchTime,
            uint256 offers,
            uint256 maxOffers,
            uint256 funds,
            uint256 maxFunds,
            bool liquidityAdded
        );
}

/// @notice BSC mainnet fork: a Flap curve quoted in PEPE, a quote asset the portal cannot
///         swap into by itself (`nativeToQuoteSwapEnabled` is false), bought with BNB and
///         sold back to BNB in ONE transaction each through the router.
contract FlapForkTest is ForkBase {
    address constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address constant PEPE = 0x25d887Ce7a35172C62FeBFD67a1856F20FaEbB00;
    address constant PANCAKE_V2 = 0x10ED43C718714eb63d5aA57B78B54704E256024E;
    address constant PORTAL = 0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0;
    /// A Flap token quoted in PEPE (TokenQuoteSet on the portal).
    address constant TOKEN = 0x2CC05d18F221eaD699866791B66B23937a697777;

    function setUp() public {
        _setUpFork("BSC_RPC_URL", "https://bsc-dataseed.bnbchain.org");
    }

    function _onCurve() internal view returns (bool) {
        (uint8 status,,,,,,, address quote, bool nativeSwap) = IFlapPortal(PORTAL).getTokenV3(TOKEN);
        assertEq(quote, PEPE);
        assertFalse(nativeSwap, "portal swaps BNB itself: no router needed");
        return status == 1;
    }

    function _path(address a, address b) internal pure returns (address[] memory p) {
        p = new address[](2);
        p[0] = a;
        p[1] = b;
    }

    function _swapData(address input, address output) internal pure returns (bytes memory) {
        return abi.encodeCall(
            IFlapPortal.swapExactInput,
            (IFlapPortal.ExactInputParams({
                    inputToken: input, outputToken: output, inputAmount: 0, minOutputAmount: 1, permitData: ""
                }))
        );
    }

    function test_buyAndSellPepeQuotedFlapCurve() public {
        vm.skip(!_onCurve());

        // BNB → PEPE (PancakeSwap v2) → curve buy with all the PEPE (the portal may pull it).
        CeleraRouter.Call[] memory buy = new CeleraRouter.Call[](2);
        buy[0] = _call(
            PANCAKE_V2,
            type(uint256).max,
            abi.encodeCall(
                IPancakeV2Router.swapExactETHForTokens, (1, _path(WBNB, PEPE), address(router), block.timestamp)
            )
        );
        // inputAmount: selector, tuple offset, inputToken, outputToken.
        buy[1] = _spend(PORTAL, _swapData(PEPE, TOKEN), PEPE, 100, PORTAL);

        CeleraRouter.Input memory none;
        vm.prank(user);
        uint256 bought = router.execute{value: 0.01 ether}(buy, none, TOKEN, 1, _list(PEPE, WBNB), block.timestamp);
        assertGt(bought, 0);
        assertEq(IERC20(TOKEN).balanceOf(user), bought);
        _assertRouterEmpty(_list(TOKEN, PEPE, WBNB));
        _assertNoAllowance(PEPE, PORTAL);

        // Sell: Permit2 pull → curve sell to PEPE → PEPE → BNB (PancakeSwap v2).
        _approvePermit2(TOKEN);
        CeleraRouter.Call[] memory sell = new CeleraRouter.Call[](2);
        sell[0] = _spend(PORTAL, _swapData(TOKEN, PEPE), TOKEN, 100, PORTAL);
        sell[1] = _spend(
            PANCAKE_V2,
            abi.encodeCall(
                IPancakeV2Router.swapExactTokensForETH, (0, 1, _path(PEPE, WBNB), address(router), block.timestamp)
            ),
            PEPE,
            4,
            PANCAKE_V2
        );
        CeleraRouter.Input memory input = _permit(TOKEN, bought);
        uint256 before = user.balance;
        vm.prank(user);
        uint256 out = router.execute(sell, input, NATIVE, 1, _list(TOKEN, PEPE, WBNB), block.timestamp);
        assertEq(user.balance - before, out);
        assertEq(IERC20(TOKEN).balanceOf(user), 0, "token not sold");
        _assertRouterEmpty(_list(TOKEN, PEPE, WBNB));
        _assertNoAllowance(TOKEN, PORTAL);
        _assertNoAllowance(PEPE, PANCAKE_V2);
        // Curve fee (1% each way) + pool fees (0.25% each way) + price impact.
        assertGt(out, 0.009 ether, "round trip lost too much");
    }
}

/// @notice BSC mainnet fork: four.meme curves quoted in BEP-20 assets (USDT, USD1, BNCB,
///         tokenised stocks) need NO router: four.meme's own helper swaps BNB into the
///         quote asset and back. This pins down the calls and the approval they need.
contract FourMemeForkTest is ForkBase {
    address constant HELPER = 0xF251F83e40a78868FcfA3FA4599Dad6494E46034;
    address constant TOKEN_MANAGER = 0x5c952063c7fc8610FFDB798152D69F0B9550762b;

    function setUp() public {
        _setUpFork("BSC_RPC_URL", "https://bsc-dataseed.bnbchain.org");
    }

    function _live(address token) internal view returns (bool) {
        (uint256 version, address manager, address quote,,,,,,,,, bool listed) = IFourHelper(HELPER).getTokenInfo(token);
        return version == 2 && manager == TOKEN_MANAGER && quote != address(0) && !listed;
    }

    function _roundTrip(address token) internal {
        vm.skip(!_live(token));
        vm.prank(user);
        IFourHelper(HELPER).buyWithEth{value: 0.01 ether}(0, token, user, 0.01 ether, 1);
        uint256 bought = IERC20(token).balanceOf(user);
        assertGt(bought, 0, "bought nothing");

        // four.meme sells whole multiples of 1e9 units. The manager pulls them from tx.origin,
        // so this sell must be sent by the wallet itself (it cannot run inside the router).
        uint256 amount = (bought / 1e9) * 1e9;
        vm.prank(user);
        IERC20(token).approve(TOKEN_MANAGER, amount);
        uint256 before = user.balance;
        vm.prank(user, user);
        IFourHelper(HELPER).sellForEth(0, token, amount, 1, 0, address(0));
        uint256 out = user.balance - before;
        assertGt(out, 0.009 ether, "round trip lost too much");
        assertEq(IERC20(token).balanceOf(user), bought - amount);
    }

    function test_usdtQuotedCurve() public {
        _roundTrip(0xAa7291fB6d5db0b0018c8974590EC65DcdbD4444);
    }

    function test_usd1QuotedCurve() public {
        _roundTrip(0xE951E321da31a7A067EB3c6f63d6F7c2CAe44444);
    }

    function test_stockQuotedCurve() public {
        _roundTrip(0x30D597f1335bFF2eE010A04b0C0159fc6780FfFf);
    }
}
