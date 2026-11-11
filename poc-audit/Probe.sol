// SPDX-License-Identifier: MIT
pragma solidity 0.8.15;
import { Lib_RLPReader } from "contracts/libraries/rlp/Lib_RLPReader.sol";
contract Probe {
    function headerNumber(bytes memory b) external pure returns (uint256) {
        Lib_RLPReader.RLPItem[] memory c = Lib_RLPReader.readList(Lib_RLPReader.toRLPItem(b));
        bytes memory raw = Lib_RLPReader.readBytes(c[8]);
        uint256 n;
        assembly { n := shr(shl(0x03, sub(0x20, mload(raw))), mload(add(raw, 0x20))) }
        return n;
    }
}
