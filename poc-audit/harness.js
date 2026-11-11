// Minimal local EVM harness. No forks, no RPC.
const { createVM, runTx, runBlock } = require('@ethereumjs/vm');
const { Common, Mainnet } = require('@ethereumjs/common');
const { createBlock, createBlockHeader } = require('@ethereumjs/block');
const { createLegacyTx } = require('@ethereumjs/tx');
const { Account, Address, hexToBytes, bytesToHex } = require('@ethereumjs/util');
const { ethers } = require('ethers');
const fs = require('fs');

class EVM {
  async init() {
    this.common = new Common({ chain: { ...Mainnet, chainId: 31337 }, hardfork: 'cancun' });
    this.vm = await createVM({ common: this.common });
    this.blockNumber = 1n; this.timestamp = 1700000000n;
    this.coinbase = new Address(hexToBytes('0x' + '11'.repeat(20)));
    await this.mine(0n);
  }
  async mine(dt = 12n) {
    this.timestamp += dt;
    const parent = this._block;
    const header = createBlockHeader({
      number: this.blockNumber, timestamp: this.timestamp,
      parentHash: parent ? parent.hash() : new Uint8Array(32),
      gasLimit: 300000000n, baseFeePerGas: 0n, coinbase: this.coinbase,
    }, { common: this.common, skipConsensusFormatValidation: true });
    this._block = createBlock({ header }, { common: this.common, skipConsensusFormatValidation: true });
    await runBlock(this.vm, { block: this._block, generate: true,
      skipBlockValidation: true, skipBalance: true, skipNonce: true, reportPreimages: false });
    this.blockNumber++;
    return this._block;
  }
  keyOf(addr) {
    if (!this.keys) this.keys = {};
    if (!this.keys[addr]) throw new Error('unknown signer ' + addr);
    return this.keys[addr];
  }
  account(seed) {
    if (!this.keys) this.keys = {};
    const key = ethers.keccak256(ethers.toUtf8Bytes('mvm-poc:' + seed));
    const a = ethers.computeAddress(key);
    this.keys[a] = key; this.seeds = this.seeds || {}; this.seeds[seed] = a;
    return a;
  }
  async nonce(addr) { const a = await this.vm.stateManager.getAccount(new Address(hexToBytes(addr))); return a ? a.nonce : 0n; }
  async setBalance(addr, v) {
    const a = new Address(hexToBytes(addr));
    const acc = (await this.vm.stateManager.getAccount(a)) || new Account();
    acc.balance = v; await this.vm.stateManager.putAccount(a, acc);
  }
  async _run(data, to, signer, value, gasLimit) {
    const key = this.keyOf(signer);
    const td = { nonce: await this.nonce(signer), gasPrice: 0n, gasLimit: gasLimit || 200000000n,
                 value, data: hexToBytes(data) };
    if (to) td.to = new Address(hexToBytes(to));
    const tx = createLegacyTx(td, { common: this.common }).sign(hexToBytes(key));
    return runTx(this.vm, { tx, skipBalance: true, skipNonce: true, block: this._block });
  }
  async deploy(name, args = [], deployer, value = 0n) {
    const art = typeof name === 'string' ? this.load(name) : name;
    const iface = new ethers.Interface(art.abi);
    const data = art.bytecode + (args.length ? iface.encodeDeploy(args).slice(2) : '');
    const res = await this._run(data, null, deployer, value);
    if (res.execResult.exceptionError)
      throw new Error(`deploy ${name} failed: ${res.execResult.exceptionError.error} ` + bytesToHex(res.execResult.returnValue).slice(0, 200));
    return { name, address: ethers.getAddress(bytesToHex(res.createdAddress.bytes)), iface };
  }
  async call(c, signer, method, args = [], value = 0n, gasLimit) {
    return this._run(c.iface.encodeFunctionData(method, args), c.address, signer, value, gasLimit);
  }
  async ok(c, signer, method, args = [], value = 0n, gasLimit) {
    const res = await this.call(c, signer, method, args, value, gasLimit);
    if (res.execResult.exceptionError) {
      const ret = bytesToHex(res.execResult.returnValue);
      let reason = '';
      try { reason = JSON.stringify(c.iface.parseError(ret)); } catch (e) {}
      throw new Error(`${method} reverted: ${res.execResult.exceptionError.error} ${reason} ${ret.slice(0, 160)}`);
    }
    return res;
  }
  async view(c, signer, method, args = []) {
    const res = await this.vm.evm.runCall({
      caller: new Address(hexToBytes(signer)), to: new Address(hexToBytes(c.address)),
      data: hexToBytes(c.iface.encodeFunctionData(method, args)), gasLimit: 150000000n, block: this._block });
    if (res.execResult.exceptionError) throw new Error(`view ${method}: ${res.execResult.exceptionError.error}`);
    return c.iface.decodeFunctionResult(method, bytesToHex(res.execResult.returnValue));
  }
  async setStorage(addr, key, value) {
    await this.vm.stateManager.putStorage(new Address(hexToBytes(addr)), hexToBytes(key), hexToBytes(value));
  }
  async getStorage(addr, key) {
    return bytesToHex(await this.vm.stateManager.getStorage(new Address(hexToBytes(addr)), hexToBytes(key)));
  }
  load(name) { return JSON.parse(fs.readFileSync(__dirname + '/build/' + name + '.json', 'utf8')); }
}
module.exports = { EVM, ethers };
