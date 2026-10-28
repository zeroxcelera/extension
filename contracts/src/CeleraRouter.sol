// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Permit2's SignatureTransfer (one-time, exact-amount pulls).
interface ISignatureTransfer {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    function permitTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external;
}

interface IERC20Balance {
    function balanceOf(address account) external view returns (uint256);
}

/// @title Celera Router
/// @notice Stateless executor: runs the steps of one trade in a single transaction and pays
///         the caller. No owner, no upgrade, no fee. It holds no funds and no allowances
///         between transactions, and never relies on allowances granted to itself.
/// @dev See contracts/README.md for the threat model.
contract CeleraRouter {
    /// @notice One step of a trade.
    /// @param target Contract to call (never this router or Permit2).
    /// @param value Ether to send; `type(uint256).max` sends the router's whole balance.
    /// @param data Calldata. Its selector must not be ERC-20 `transferFrom`, `approve` or
    ///        `increaseAllowance`: the router grants allowances itself (see `spender`).
    /// @param injectToken When non-zero, the router's current balance of this token
    ///        (`NATIVE` for ether) is written into `data` at `injectOffset` before the call.
    /// @param injectOffset Byte offset of a 32-byte word in `data`, after the selector.
    /// @param spender When non-zero, may pull exactly the injected amount of `injectToken`
    ///        (an ERC-20) during this call only: approved just before it, reset to zero after.
    struct Call {
        address target;
        uint256 value;
        bytes data;
        address injectToken;
        uint256 injectOffset;
        address spender;
    }

    /// @notice Token input pulled from the caller with a Permit2 signature (amount 0: none).
    struct Input {
        ISignatureTransfer.PermitTransferFrom permit;
        bytes signature;
    }

    /// @notice Stands for ether in `tokenOut`, `sweep` and `injectToken`.
    address public constant NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /// @dev ERC-20 `transferFrom(address,address,uint256)`.
    bytes4 private constant TRANSFER_FROM = 0x23b872dd;
    /// @dev ERC-20 `transfer(address,uint256)`.
    bytes4 private constant TRANSFER = 0xa9059cbb;
    /// @dev ERC-20 `approve(address,uint256)`.
    bytes4 private constant APPROVE = 0x095ea7b3;
    /// @dev `increaseAllowance(address,uint256)` (OpenZeppelin-style tokens).
    bytes4 private constant INCREASE_ALLOWANCE = 0x39509351;

    uint256 private constant SELECTOR_SIZE = 4;
    uint256 private constant WORD_SIZE = 32;

    ISignatureTransfer public immutable PERMIT2;

    uint256 private _lock = 1;

    error Expired();
    error Reentrancy();
    error BlockedCall(uint256 index);
    error BadInjection(uint256 index);
    error BadApproval(uint256 index);
    error CallFailed(uint256 index, bytes reason);
    error ApprovalFailed(address token);
    error TransferFailed(address token);
    error InsufficientOutput(uint256 out, uint256 minOut);

    event Executed(address indexed user, address indexed tokenOut, uint256 amountOut);

    constructor(ISignatureTransfer permit2) {
        PERMIT2 = permit2;
    }

    /// @dev Ether from venues (sells, unwraps) and refunds.
    receive() external payable {}

    /// @notice Runs `calls`, then pays the caller its whole balance of `tokenOut`, of each
    ///         `sweep` token and of ether, and requires the caller's `tokenOut` balance to
    ///         have grown by at least `minOut`.
    /// @return out The increase in the caller's `tokenOut` balance.
    function execute(
        Call[] calldata calls,
        Input calldata input,
        address tokenOut,
        uint256 minOut,
        address[] calldata sweep,
        uint256 deadline
    ) external payable returns (uint256 out) {
        if (block.timestamp > deadline) revert Expired();
        if (_lock != 1) revert Reentrancy();
        _lock = 2;

        uint256 before = _balanceOf(tokenOut, msg.sender);

        uint256 pull = input.permit.permitted.amount;
        if (pull != 0) {
            // Owner is always the caller: a signature can only spend its signer's tokens.
            PERMIT2.permitTransferFrom(
                input.permit,
                ISignatureTransfer.SignatureTransferDetails({to: address(this), requestedAmount: pull}),
                msg.sender,
                input.signature
            );
        }

        for (uint256 i = 0; i < calls.length; ++i) {
            _run(calls[i], i);
        }

        _sendAll(tokenOut, msg.sender);
        for (uint256 i = 0; i < sweep.length; ++i) {
            _sendAll(sweep[i], msg.sender);
        }
        _sendAll(NATIVE, msg.sender);

        out = _balanceOf(tokenOut, msg.sender) - before;
        if (out < minOut) revert InsufficientOutput(out, minOut);

        _lock = 1;
        emit Executed(msg.sender, tokenOut, out);
    }

    function _run(Call calldata c, uint256 i) private {
        address target = c.target;
        if (target == address(this) || target == address(PERMIT2)) revert BlockedCall(i);

        bytes memory data = c.data;
        if (data.length >= SELECTOR_SIZE) {
            bytes4 selector = bytes4(data);
            // No spending of others' allowances, and no allowance can outlive its step.
            if (selector == TRANSFER_FROM || selector == APPROVE || selector == INCREASE_ALLOWANCE) {
                revert BlockedCall(i);
            }
        }

        address token = c.injectToken;
        uint256 amount = 0;
        if (token != address(0)) {
            uint256 offset = c.injectOffset;
            if (offset < SELECTOR_SIZE || offset > data.length || data.length - offset < WORD_SIZE) {
                revert BadInjection(i);
            }
            amount = _balanceOf(token, address(this));
            assembly ("memory-safe") {
                mstore(add(add(data, WORD_SIZE), offset), amount)
            }
        }

        address spender = c.spender;
        if (spender != address(0)) {
            if (token == address(0) || token == NATIVE) revert BadApproval(i);
            _approve(token, spender, amount);
        }

        uint256 value = c.value == type(uint256).max ? address(this).balance : c.value;
        (bool ok, bytes memory reason) = target.call{value: value}(data);
        if (!ok) revert CallFailed(i, reason);

        if (spender != address(0)) _approve(token, spender, 0);
    }

    /// @dev `approve` for tokens with or without a return value; `false` reverts.
    function _approve(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(APPROVE, spender, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert ApprovalFailed(token);
    }

    /// @dev Sends this router's whole balance of `token` (or ether) to `to`.
    function _sendAll(address token, address to) private {
        if (token == NATIVE) {
            uint256 balance = address(this).balance;
            if (balance == 0) return;
            (bool sent,) = to.call{value: balance}("");
            if (!sent) revert TransferFailed(token);
            return;
        }
        uint256 amount = IERC20Balance(token).balanceOf(address(this));
        if (amount == 0) return;
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(TRANSFER, to, amount));
        // Tokens that return nothing (e.g. USDT) are accepted; `false` is not.
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed(token);
    }

    function _balanceOf(address token, address account) private view returns (uint256) {
        return token == NATIVE ? account.balance : IERC20Balance(token).balanceOf(account);
    }
}
