// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CeleraRouter, ISignatureTransfer} from "../src/CeleraRouter.sol";

contract MockERC20 {
    string public name;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory n) {
        name = n;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external virtual returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external virtual returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal virtual {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// @dev Takes 5% of every transfer.
contract TaxToken is MockERC20 {
    constructor() MockERC20("TAX") {}

    function _move(address from, address to, uint256 amount) internal override {
        require(balanceOf[from] >= amount, "balance");
        uint256 tax = amount / 20;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - tax;
    }
}

/// @dev Like USDT: `transfer` and `approve` return nothing.
contract NoReturnToken is MockERC20 {
    constructor() MockERC20("NORET") {}

    function transfer(address to, uint256 amount) external override returns (bool) {
        _move(msg.sender, to, amount);
        assembly {
            return(0, 0)
        }
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        allowance[msg.sender][spender] = amount;
        assembly {
            return(0, 0)
        }
    }
}

/// @dev `approve` answers `false`.
contract FalseApproveToken is MockERC20 {
    constructor() MockERC20("NOAPPROVE") {}

    function approve(address, uint256) external pure override returns (bool) {
        return false;
    }
}

/// @dev A spender that pulls only half of what it may: without the reset, the rest of the
///      allowance would stay on the router.
contract Skimmer {
    function take(MockERC20 t, uint256 amount) external {
        t.transferFrom(msg.sender, address(this), amount / 2);
    }
}

/// @dev Ether → quote asset at 1:1000, paid to the caller.
contract MockDex {
    MockERC20 public immutable quote;

    constructor(MockERC20 q) {
        quote = q;
    }

    function buyQuote() external payable {
        quote.mint(msg.sender, msg.value * 1000);
    }

    function sellQuote(uint256 amount) external {
        quote.transferFrom(msg.sender, address(this), amount);
        payable(msg.sender).transfer(amount / 1000);
    }

    receive() external payable {}
}

/// @dev A curve quoted in an ERC-20: pulls the quote asset, pays the caller.
contract MockCurve {
    MockERC20 public immutable quote;
    MockERC20 public immutable token;

    constructor(MockERC20 q, MockERC20 t) {
        quote = q;
        token = t;
    }

    function buy(uint256 quoteIn, uint256 minOut) external {
        quote.transferFrom(msg.sender, address(this), quoteIn);
        uint256 out = quoteIn * 2;
        require(out >= minOut, "slippage");
        token.mint(msg.sender, out);
    }

    function sell(uint256 tokenIn) external {
        token.transferFrom(msg.sender, address(this), tokenIn);
        quote.mint(msg.sender, tokenIn / 2);
    }
}

/// @dev Tries to re-enter the router from inside a step.
contract Reenterer {
    function poke(CeleraRouter router) external {
        CeleraRouter.Call[] memory none = new CeleraRouter.Call[](0);
        CeleraRouter.Input memory noInput;
        router.execute(
            none, noInput, address(0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE), 0, new address[](0), type(uint256).max
        );
    }
}

/// @dev Stands in for Permit2 in unit tests: honours signatures blindly, so tests can show
///      the router only ever pulls from `msg.sender`.
contract FakePermit2 is ISignatureTransfer {
    address public lastOwner;

    function permitTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata details,
        address owner,
        bytes calldata
    ) external {
        lastOwner = owner;
        MockERC20(permit.permitted.token).transferFrom(owner, details.to, details.requestedAmount);
    }
}
