// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CeleraRouter, ISignatureTransfer} from "../../src/CeleraRouter.sol";

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IERC20Allowance {
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IWETH {
    function withdraw(uint256 amount) external;
}

interface IPermit2Domain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @notice Shared setup for mainnet-fork tests: a fresh router, a funded user with a key
///         (for Permit2 signatures) and step helpers.
abstract contract ForkBase is Test {
    address constant NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    bytes32 constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 constant PERMIT_TRANSFER_FROM_TYPEHASH = keccak256(
        "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
    );

    CeleraRouter router;
    address user;
    uint256 userKey;

    function _setUpFork(string memory rpcEnv, string memory fallbackRpc) internal {
        vm.createSelectFork(vm.envOr(rpcEnv, fallbackRpc));
        // Execute as the chains do today (venues use transient storage); the router itself
        // is still compiled for Shanghai.
        vm.setEvmVersion("cancun");
        router = new CeleraRouter(ISignatureTransfer(PERMIT2));
        // A label nobody else uses: common ones ("user") may have EIP-7702 code on mainnet.
        (user, userKey) = makeAddrAndKey("celera-router-fork-user-5e1b");
        assertEq(user.code.length, 0);
        vm.deal(user, 1 ether);
        assertGt(PERMIT2.code.length, 0);
    }

    function _call(address target, uint256 value, bytes memory data) internal pure returns (CeleraRouter.Call memory) {
        return CeleraRouter.Call({
            target: target, value: value, data: data, injectToken: address(0), injectOffset: 0, spender: address(0)
        });
    }

    /// A call spending the router's whole balance of `token`, written at `offset`.
    function _inject(address target, bytes memory data, address token, uint256 offset)
        internal
        pure
        returns (CeleraRouter.Call memory)
    {
        return _spend(target, data, token, offset, address(0));
    }

    /// Same, and `spender` may pull that amount during this call only.
    function _spend(address target, bytes memory data, address token, uint256 offset, address spender)
        internal
        pure
        returns (CeleraRouter.Call memory)
    {
        return CeleraRouter.Call({
            target: target, value: 0, data: data, injectToken: token, injectOffset: offset, spender: spender
        });
    }

    function _assertNoAllowance(address token, address spender) internal view {
        assertEq(IERC20Allowance(token).allowance(address(router), spender), 0, "allowance left");
    }

    function _permit(address token, uint256 amount) internal view returns (CeleraRouter.Input memory input) {
        input.permit.permitted = ISignatureTransfer.TokenPermissions({token: token, amount: amount});
        input.permit.nonce = 7;
        input.permit.deadline = block.timestamp + 600;
        bytes32 structHash = keccak256(
            abi.encode(
                PERMIT_TRANSFER_FROM_TYPEHASH,
                keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, token, amount)),
                address(router),
                input.permit.nonce,
                input.permit.deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IPermit2Domain(PERMIT2).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userKey, digest);
        input.signature = abi.encodePacked(r, s, v);
    }

    /// Lets Permit2 move the user's `token` (done once per token in the extension).
    function _approvePermit2(address token) internal {
        vm.prank(user);
        IERC20(token).approve(PERMIT2, type(uint256).max);
    }

    function _assertRouterEmpty(address[] memory tokens) internal view {
        assertEq(address(router).balance, 0, "ether left");
        for (uint256 i; i < tokens.length; ++i) {
            assertEq(IERC20(tokens[i]).balanceOf(address(router)), 0, "token left");
        }
    }

    function _list(address a, address b) internal pure returns (address[] memory l) {
        l = new address[](2);
        l[0] = a;
        l[1] = b;
    }

    function _list(address a, address b, address c) internal pure returns (address[] memory l) {
        l = new address[](3);
        l[0] = a;
        l[1] = b;
        l[2] = c;
    }
}
