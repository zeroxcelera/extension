// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CeleraRouter} from "../../src/CeleraRouter.sol";
import {ForkBase, IERC20, IWETH} from "./ForkBase.sol";

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256);
}

interface IBonding {
    function tokenInfos(uint256 index) external view returns (address);
    function buy(uint256 amountIn, address token, uint256 amountOutMin, uint256 deadline)
        external
        payable
        returns (bool);
    function sell(uint256 amountIn, address token, uint256 amountOutMin, uint256 deadline) external returns (bool);
}

/// @notice Base mainnet fork: a Virtuals curve token (quoted in VIRTUAL) bought with ether and
///         sold back to ether, each in ONE transaction through the router, with the real
///         Uniswap and Permit2 contracts. Needs BASE_RPC_URL (a public endpoint works).
contract VirtualsForkTest is ForkBase {
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant VIRTUAL = 0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b;
    address constant SWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant BONDING = 0x1A540088125d00dD3990f9dA45CA0859af4d3B01;
    address constant FROUTER = 0x02FE8eC3d9BBf7318eb54590bcC39198a8b47deD;

    function setUp() public {
        _setUpFork("BASE_RPC_URL", "https://base-rpc.publicnode.com");
        assertGt(SWAP_ROUTER.code.length, 0);
        assertGt(BONDING.code.length, 0);
    }

    /// Ether → VIRTUAL (Uniswap v3 0.05%) → curve buy (the curve router may pull the VIRTUAL).
    function _buyCalls(address token) internal view returns (CeleraRouter.Call[] memory calls) {
        calls = new CeleraRouter.Call[](2);
        calls[0] = _call(
            SWAP_ROUTER,
            type(uint256).max,
            abi.encodeCall(
                ISwapRouter02.exactInputSingle,
                (ISwapRouter02.ExactInputSingleParams(WETH, VIRTUAL, 500, address(router), 0.002 ether, 1, 0))
            )
        );
        calls[1] =
            _spend(BONDING, abi.encodeCall(IBonding.buy, (0, token, 1, block.timestamp + 600)), VIRTUAL, 4, FROUTER);
    }

    function _latestIndex() internal view returns (uint256 lo) {
        uint256 hi = 1 << 20;
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            try IBonding(BONDING).tokenInfos(mid) returns (address) {
                lo = mid;
            } catch {
                hi = mid;
            }
        }
    }

    /// Buys the newest token still trading on the curve; returns it (or zero if none).
    function _buyLive() internal returns (address token) {
        uint256 top = _latestIndex();
        address[] memory sweep = new address[](1);
        sweep[0] = VIRTUAL;
        CeleraRouter.Input memory none;
        for (uint256 i = top; i + 15 > top && i > 0; --i) {
            address candidate = IBonding(BONDING).tokenInfos(i);
            vm.prank(user);
            try router.execute{value: 0.002 ether}(
                _buyCalls(candidate), none, candidate, 1, sweep, block.timestamp
            ) returns (
                uint256
            ) {
                return candidate;
            } catch {}
        }
    }

    function _assertRouterEmpty(address token) internal view {
        _assertRouterEmpty(_list(token, VIRTUAL, WETH));
        _assertNoAllowance(token, FROUTER);
        _assertNoAllowance(VIRTUAL, FROUTER);
        _assertNoAllowance(VIRTUAL, SWAP_ROUTER);
    }

    function test_buyAndSellVirtualsCurveInOneTransactionEach() public {
        address token = _buyLive();
        vm.skip(token == address(0));
        uint256 bought = IERC20(token).balanceOf(user);
        assertGt(bought, 0, "bought nothing");
        _assertRouterEmpty(token);

        // Sell everything back to ether: Permit2 pull → curve sell → VIRTUAL → WETH → ether.
        _approvePermit2(token);
        CeleraRouter.Call[] memory calls = new CeleraRouter.Call[](3);
        calls[0] =
            _spend(BONDING, abi.encodeCall(IBonding.sell, (0, token, 1, block.timestamp + 600)), token, 4, FROUTER);
        calls[1] = _spend(
            SWAP_ROUTER,
            abi.encodeCall(
                ISwapRouter02.exactInputSingle,
                (ISwapRouter02.ExactInputSingleParams(VIRTUAL, WETH, 500, address(router), 0, 1, 0))
            ),
            VIRTUAL,
            132, // amountIn: selector + four static words before it
            SWAP_ROUTER
        );
        calls[2] = _inject(WETH, abi.encodeCall(IWETH.withdraw, (0)), WETH, 4);

        address[] memory sweep = new address[](3);
        sweep[0] = token;
        sweep[1] = VIRTUAL;
        sweep[2] = WETH;
        // Built first: vm.prank applies to the next external call, and signing reads Permit2.
        CeleraRouter.Input memory input = _permit(token, bought);
        uint256 ethBefore = user.balance;
        vm.prank(user);
        uint256 out = router.execute(calls, input, NATIVE, 1, sweep, block.timestamp);
        assertGt(out, 0, "no ether back");
        assertEq(user.balance - ethBefore, out);
        assertEq(IERC20(token).balanceOf(user), 0, "token not sold");
        _assertRouterEmpty(token);
        // Round trip costs curve + pool fees only: well over half the ether comes back.
        assertGt(out, 0.001 ether, "round trip lost too much");
    }

    function test_signatureForOneRouterCallCannotBeReplayed() public {
        address token = _buyLive();
        vm.skip(token == address(0));
        uint256 bought = IERC20(token).balanceOf(user);
        _approvePermit2(token);
        CeleraRouter.Input memory input = _permit(token, bought / 2);
        address[] memory sweep = new address[](1);
        sweep[0] = token;

        // The same signature, used by someone else: Permit2 checks it against the caller.
        address attacker = makeAddr("celera-router-fork-attacker-5e1b");
        vm.prank(attacker);
        // Permit2's SignatureVerification.InvalidSigner(): recovered signer != caller.
        vm.expectRevert(bytes4(keccak256("InvalidSigner()")));
        router.execute(new CeleraRouter.Call[](0), input, token, 0, sweep, block.timestamp);
        assertEq(IERC20(token).balanceOf(user), bought);
    }
}
