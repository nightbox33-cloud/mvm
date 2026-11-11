// SPDX-License-Identifier: MIT
pragma solidity 0.8.15;
// PoC test doubles (NOT audited code): Cannon VM and the proposer registry.
interface IOracle { function challengePeriod() external view returns (uint256); }
contract MockOracle { uint256 public period; constructor(uint256 p) { period = p; }
    function challengePeriod() external view returns (uint256) { return period; } }
contract MockMIPS {
    IOracle public oracle;
    constructor(IOracle o) { oracle = o; }
    function step(bytes calldata, bytes calldata, bytes32) external pure returns (bytes32) { return bytes32(0); }
}
contract MockProposerRegistry {
    address public p;
    constructor(address _p) { p = _p; }
    function getProposer(uint256) external view returns (address) { return p; }
    function setProposer(uint256, address _p) external { p = _p; }
}
