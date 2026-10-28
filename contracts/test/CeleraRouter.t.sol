// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CeleraRouter, ISignatureTransfer} from "../src/CeleraRouter.sol";
import {
    FakePermit2,
    FalseApproveToken,
    MockCurve,
    MockDex,
    MockERC20,
    NoReturnToken,
    Reenterer,
    Skimmer,
    TaxToken
} from "./Mocks.sol";

contract CeleraRouterTest is Test {
    address constant NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    CeleraRouter router;
    FakePermit2 permit2;
    MockERC20 quote;
    MockERC20 token;
    MockDex dex;
    MockCurve curve;

    address user = makeAddr("user");
    address attacker = makeAddr("attacker");
    address victim = makeAddr("victim");

    function setUp() public {
        permit2 = new FakePermit2();
        router = new CeleraRouter(permit2);
        quote = new MockERC20("QUOTE");
        token = new MockERC20("TOKEN");
        dex = new MockDex(quote);
        curve = new MockCurve(quote, token);
        vm.deal(user, 10 ether);
        vm.deal(address(dex), 100 ether);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _call(address target, uint256 value, bytes memory data) internal pure returns (CeleraRouter.Call memory) {
        return CeleraRouter.Call({
            target: target, value: value, data: data, injectToken: address(0), injectOffset: 0, spender: address(0)
        });
    }

    /// A call spending the router's whole balance of `tokenIn`, which `spender` may pull.
    function _inject(address target, bytes memory data, address tokenIn, uint256 offset, address spender)
        internal
        pure
        returns (CeleraRouter.Call memory)
    {
        return CeleraRouter.Call({
            target: target, value: 0, data: data, injectToken: tokenIn, injectOffset: offset, spender: spender
        });
    }

    function _noInput() internal pure returns (CeleraRouter.Input memory input) {}

    function _pull(address tokenIn, uint256 amount) internal pure returns (CeleraRouter.Input memory input) {
        input.permit.permitted = ISignatureTransfer.TokenPermissions({token: tokenIn, amount: amount});
        input.permit.deadline = type(uint256).max;
        input.signature = hex"01";
    }

    function _one(address a) internal pure returns (address[] memory s) {
        s = new address[](1);
        s[0] = a;
    }

    /// native → quote (dex) → curve buy with exactly what arrived (the curve may pull it).
    function _buyCalls() internal view returns (CeleraRouter.Call[] memory calls) {
        calls = new CeleraRouter.Call[](2);
        calls[0] = _call(address(dex), type(uint256).max, abi.encodeCall(MockDex.buyQuote, ()));
        calls[1] = _inject(address(curve), abi.encodeCall(MockCurve.buy, (0, 1)), address(quote), 4, address(curve));
    }

    function _assertEmpty() internal view {
        assertEq(address(router).balance, 0, "ether left in router");
        assertEq(quote.balanceOf(address(router)), 0, "quote left in router");
        assertEq(token.balanceOf(address(router)), 0, "token left in router");
        assertEq(quote.allowance(address(router), address(curve)), 0, "allowance left (quote, curve)");
        assertEq(quote.allowance(address(router), address(dex)), 0, "allowance left (quote, dex)");
        assertEq(token.allowance(address(router), address(curve)), 0, "allowance left (token, curve)");
    }

    // ── happy paths ─────────────────────────────────────────────────────────

    function test_buyThroughQuoteAsset() public {
        vm.prank(user);
        uint256 out = router.execute{value: 1 ether}(
            _buyCalls(), _noInput(), address(token), 2000 ether, _one(address(quote)), block.timestamp
        );
        assertEq(out, 2000 ether);
        assertEq(token.balanceOf(user), 2000 ether);
        _assertEmpty();
    }

    function test_sellThroughQuoteAssetWithPermit() public {
        token.mint(user, 1000 ether);
        vm.prank(user);
        token.approve(address(permit2), type(uint256).max);

        CeleraRouter.Call[] memory calls = new CeleraRouter.Call[](2);
        calls[0] = _inject(address(curve), abi.encodeCall(MockCurve.sell, (0)), address(token), 4, address(curve));
        calls[1] = _inject(address(dex), abi.encodeCall(MockDex.sellQuote, (0)), address(quote), 4, address(dex));

        address[] memory sweep = new address[](2);
        sweep[0] = address(token);
        sweep[1] = address(quote);
        uint256 before = user.balance;
        vm.prank(user);
        uint256 out =
            router.execute(calls, _pull(address(token), 1000 ether), NATIVE, 0.5 ether, sweep, block.timestamp);
        assertEq(out, 0.5 ether);
        assertEq(user.balance - before, 0.5 ether);
        assertEq(permit2.lastOwner(), user, "input must come from the caller");
        _assertEmpty();
    }

    function test_refundsUnusedEther() public {
        CeleraRouter.Call[] memory calls = _buyCalls();
        calls[0].value = 1 ether; // spend 1 of the 3 sent
        uint256 before = user.balance;
        vm.prank(user);
        router.execute{value: 3 ether}(calls, _noInput(), address(token), 1, _one(address(quote)), block.timestamp);
        assertEq(before - user.balance, 1 ether);
        _assertEmpty();
    }

    function test_feeOnTransferOutputIsMeasuredAtTheCaller() public {
        TaxToken tax = new TaxToken();
        MockCurve taxCurve = new MockCurve(quote, tax);
        CeleraRouter.Call[] memory calls = new CeleraRouter.Call[](2);
        calls[0] = _call(address(dex), type(uint256).max, abi.encodeCall(MockDex.buyQuote, ()));
        calls[1] =
            _inject(address(taxCurve), abi.encodeCall(MockCurve.buy, (0, 1)), address(quote), 4, address(taxCurve));

        // 2000 minted to the router, 5% taxed on the way to the caller: 1900 arrive.
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(CeleraRouter.InsufficientOutput.selector, 1900 ether, 1901 ether));
        router.execute{value: 1 ether}(
            calls, _noInput(), address(tax), 1901 ether, _one(address(quote)), block.timestamp
        );

        vm.prank(user);
        uint256 out = router.execute{value: 1 ether}(
            calls, _noInput(), address(tax), 1900 ether, _one(address(quote)), block.timestamp
        );
        assertEq(out, 1900 ether);
    }

    function test_sweepsTokensWithoutReturnValue() public {
        NoReturnToken usdtLike = new NoReturnToken();
        usdtLike.mint(address(router), 5); // e.g. dust left by a step
        vm.prank(user);
        router.execute{value: 1 ether}(
            _buyCalls(), _noInput(), address(token), 1, _one(address(usdtLike)), block.timestamp
        );
        assertEq(usdtLike.balanceOf(user), 5);
    }

    function test_approvesTokensWithoutReturnValue() public {
        NoReturnToken usdtLike = new NoReturnToken();
        MockCurve c = new MockCurve(usdtLike, token);
        usdtLike.mint(address(router), 10);
        CeleraRouter.Call[] memory calls = new CeleraRouter.Call[](1);
        calls[0] = _inject(address(c), abi.encodeCall(MockCurve.buy, (0, 1)), address(usdtLike), 4, address(c));
        vm.prank(user);
        assertEq(router.execute(calls, _noInput(), address(token), 20, new address[](0), block.timestamp), 20);
        assertEq(usdtLike.allowance(address(router), address(c)), 0);
    }

    // ── attacks ─────────────────────────────────────────────────────────────

    function test_cannotSpendSomeoneElsesAllowance() public {
        token.mint(victim, 100 ether);
        vm.prank(victim);
        token.approve(address(router), type(uint256).max); // a mistaken approval

        CeleraRouter.Call[] memory calls = new CeleraRouter.Call[](1);
        calls[0] = _call(address(token), 0, abi.encodeCall(MockERC20.transferFrom, (victim, attacker, 100 ether)));
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(CeleraRouter.BlockedCall.selector, 0));
        router.execute(calls, _noInput(), address(token), 0, new address[](0), block.timestamp);
        assertEq(token.balanceOf(victim), 100 ether);
    }

    /// An allowance left on the router would let its holder skim a later user's funds while
    /// the router holds them. Steps cannot approve; only the router does, for one call.
    function test_cannotPlantAnAllowance() public {
        bytes[2] memory plants = [
            abi.encodeCall(MockERC20.approve, (attacker, type(uint256).max)),
            abi.encodeWithSelector(bytes4(keccak256("increaseAllowance(address,uint256)")), attacker, type(uint256).max)
        ];
        for (uint256 i; i < plants.length; ++i) {
            CeleraRouter.Call[] memory calls = new CeleraRouter.Call[](1);
            calls[0] = _call(address(quote), 0, plants[i]);
            vm.prank(attacker);
            vm.expectRevert(abi.encodeWithSelector(CeleraRouter.BlockedCall.selector, 0));
            router.execute(calls, _noInput(), NATIVE, 0, new address[](0), block.timestamp);
        }
    }

    /// Even a spender the router approved cannot keep anything: the allowance ends with the call.
    function test_approvalEndsWithItsCall() public {
        Skimmer skimmer = new Skimmer();
        quote.mint(address(router), 50);
        CeleraRouter.Call[] memory calls = new CeleraRouter.Call[](1);
        calls[0] =
            _inject(address(skimmer), abi.encodeCall(Skimmer.take, (quote, 0)), address(quote), 36, address(skimmer));
        vm.prank(attacker);
        router.execute(calls, _noInput(), NATIVE, 0, new address[](0), block.timestamp);
        assertEq(quote.allowance(address(router), address(skimmer)), 0);
    }

    function test_approvalNeedsAnInjectedToken() public {
        CeleraRouter.Call[] memory calls = new CeleraRouter.Call[](1);
        calls[0] = _inject(address(curve), abi.encodeCall(MockCurve.buy, (0, 1)), address(0), 0, address(curve));
        vm.expectRevert(abi.encodeWithSelector(CeleraRouter.BadApproval.selector, 0));
        router.execute(calls, _noInput(), NATIVE, 0, new address[](0), block.timestamp);

        calls[0] = _inject(address(curve), abi.encodeCall(MockCurve.buy, (0, 1)), NATIVE, 4, address(curve));
        vm.expectRevert(abi.encodeWithSelector(CeleraRouter.BadApproval.selector, 0));
        router.execute(calls, _noInput(), NATIVE, 0, new address[](0), block.timestamp);
    }

    function test_refusedApprovalReverts() public {
        FalseApproveToken bad = new FalseApproveToken();
        bad.mint(address(router), 1);
        CeleraRouter.Call[] memory calls = new CeleraRouter.Call[](1);
        calls[0] = _inject(address(curve), abi.encodeCall(MockCurve.buy, (0, 1)), address(bad), 4, address(curve));
        vm.expectRevert(abi.encodeWithSelector(CeleraRouter.ApprovalFailed.selector, address(bad)));
        router.execute(calls, _noInput(), NATIVE, 0, new address[](0), block.timestamp);
    }

    function test_permitInputIsAlwaysPulledFromTheCaller() public {
        token.mint(victim, 100 ether);
        vm.prank(victim);
        token.approve(address(permit2), type(uint256).max);

        // The attacker replays a victim's input: the router asks Permit2 for the attacker's
        // own tokens, so nothing of the victim's moves.
        vm.prank(attacker);
        vm.expectRevert();
        router.execute(
            new CeleraRouter.Call[](0),
            _pull(address(token), 100 ether),
            address(token),
            0,
            new address[](0),
            block.timestamp
        );
        assertEq(token.balanceOf(victim), 100 ether);
    }

    function test_cannotCallPermit2OrTheRouter() public {
        CeleraRouter.Call[] memory calls = new CeleraRouter.Call[](1);
        calls[0] = _call(address(permit2), 0, hex"00");
        vm.expectRevert(abi.encodeWithSelector(CeleraRouter.BlockedCall.selector, 0));
        router.execute(calls, _noInput(), NATIVE, 0, new address[](0), block.timestamp);

        calls[0] = _call(address(router), 0, hex"00");
        vm.expectRevert(abi.encodeWithSelector(CeleraRouter.BlockedCall.selector, 0));
        router.execute(calls, _noInput(), NATIVE, 0, new address[](0), block.timestamp);
    }

    function test_cannotReenter() public {
        Reenterer r = new Reenterer();
        CeleraRouter.Call[] memory calls = new CeleraRouter.Call[](1);
        calls[0] = _call(address(r), 0, abi.encodeCall(Reenterer.poke, (router)));
        vm.expectRevert(
            abi.encodeWithSelector(
                CeleraRouter.CallFailed.selector, 0, abi.encodeWithSelector(CeleraRouter.Reentrancy.selector)
            )
        );
        router.execute(calls, _noInput(), NATIVE, 0, new address[](0), block.timestamp);
    }

    function test_enforcesMinimumOutput() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(CeleraRouter.InsufficientOutput.selector, 2000 ether, 2001 ether));
        router.execute{value: 1 ether}(
            _buyCalls(), _noInput(), address(token), 2001 ether, _one(address(quote)), block.timestamp
        );
    }

    function test_enforcesDeadline() public {
        vm.warp(1000);
        vm.expectRevert(CeleraRouter.Expired.selector);
        router.execute(new CeleraRouter.Call[](0), _noInput(), NATIVE, 0, new address[](0), 999);
    }

    function test_rejectsBadInjectionOffsets() public {
        CeleraRouter.Call[] memory calls = new CeleraRouter.Call[](1);
        bytes memory data = abi.encodeCall(MockCurve.buy, (0, 1)); // 68 bytes
        uint256[3] memory bad = [uint256(0), 37, type(uint256).max];
        for (uint256 i; i < bad.length; ++i) {
            calls[0] = _inject(address(curve), data, address(quote), bad[i], address(0));
            vm.expectRevert(abi.encodeWithSelector(CeleraRouter.BadInjection.selector, 0));
            router.execute(calls, _noInput(), NATIVE, 0, new address[](0), block.timestamp);
        }
    }

    function test_failedStepRevertsEverything() public {
        CeleraRouter.Call[] memory calls = _buyCalls();
        calls[1] = _inject(
            address(curve), abi.encodeCall(MockCurve.buy, (0, type(uint256).max)), address(quote), 4, address(curve)
        );
        uint256 before = user.balance;
        vm.prank(user);
        vm.expectRevert();
        router.execute{value: 1 ether}(calls, _noInput(), address(token), 1, _one(address(quote)), block.timestamp);
        assertEq(user.balance, before);
    }

    // ── invariant-style fuzz ────────────────────────────────────────────────

    /// Whatever the amount, a successful buy leaves nothing in the router — no funds, no
    /// allowances — and pays exactly what the curve produced.
    function testFuzz_buyLeavesRouterEmpty(uint96 amount) public {
        vm.assume(amount > 1000);
        vm.deal(user, amount);
        vm.prank(user);
        uint256 out = router.execute{value: amount}(
            _buyCalls(), _noInput(), address(token), 1, _one(address(quote)), block.timestamp
        );
        assertEq(out, uint256(amount) * 2000);
        _assertEmpty();
    }
}
