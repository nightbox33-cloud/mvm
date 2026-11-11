# Auditoría de seguridad — Metis `mvm` (contratos L1)

**Repositorio:** `nightbox33-cloud/mvm` (idéntico a `MetisProtocol/mvm`)
**Commit auditado:** `61ef7e9a9a1f404505279e1d86f2c26a885bcc86` (rama `develop`, 2026-10-17)
**Alcance:** `packages/contracts/contracts/**` (L1 + MVM), despliegues e scripts de `packages/contracts/deploy/` y `packages/contracts/deployments/andromeda/`
**Fecha del informe:** 2026-11-11

---

## 0. Resumen ejecutivo

Se encontraron **2 vulnerabilidades CRÍTICAS** encadenadas, ambas en código de producción del sistema de *fault proofs* de Metis, ambas **permissionless** y con **PoC local ejecutable** contra los contratos reales compilados sin modificar del repositorio:

| ID | Título | Archivo | PnL del atacante (PoC) |
|----|--------|---------|------------------------|
| **H-1** | Cualquiera puede abrir un juego de disputa cuyo `rootClaim` (una raíz de estado **verdadera**) y su `l2BlockNumber()` (un bloque de **otro** batch) son mutuamente inconsistentes; el contador especial `challengeRootL2Block` gana el juego **sin probar fraude** y paga el bono completo a `disputeCreator()`. | `contracts/L1/dispute/FaultDisputeGame.sol` | +4 METIS (bono) por juego |
| **H-2** | `LockingPool.slash(_recipient)` mueve `slashRatio/10000` del saldo de **TODOS** los stakers al `_recipient` que elige el ganador del juego. `resolve()` lo llama automáticamente al ganar el challenger. | `contracts/L1/dispute/LockingPool.sol` | **+100 096 METIS** (4 METIS de coste) |

El PoC ejecuta la cadena completa sobre `DisputeGameFactory`, `FaultDisputeGame`, `MVM_StateCommitmentChain` (+ su `ChainStorageContainer` real detrás de `L1ChugSplashProxy`), `LockingPool`, `DelayedWMetis` y `MetisConfig`, con los parámetros de producción de Andrómeda. Resultado (`poc-audit/run.log`):

```
 attacker paid (init bond)     : 4.0 METIS
 attacker received             : 100100.0 METIS
 attacker NET PnL              : 100096.0 METIS
 METIS removed from stakers    : 100000.0 METIS (1000 bps)
 victims:
    0xDD119Dce... was owed 500000.0 METIS -> accounted 450000.0 METIS
    0x2E20f158... was owed 300000.0 METIS -> accounted 270000.0 METIS
    0x66969Ea2... was owed 200000.0 METIS -> accounted 180000.0 METIS
>>> PROFITABLE: 4 METIS risked, 100096.0 METIS of third-party funds taken
```

Ambos hallazgos cumplen los cuatro criterios exigidos: bug concreto en código de producción, disparable con transacciones normales sin rol alguno, call graph verificado contra despliegues reales, y PoC local con PnL positivo a costa de fondos de terceros.

---

## 1. Verificación de acceso al código (requisito previo)

| Comprobación | Comando | Resultado |
|---|---|---|
| Commit exacto | `git log -1 --format=%H` | `61ef7e9a9a1f404505279e1d86f2c26a885bcc86` |
| Repo del workspace == upstream | `git clone --depth 1 https://github.com/MetisProtocol/mvm /tmp/metis_up && diff -rq` | sin diferencias en `packages/contracts/{contracts,deploy}` ni en el árbol completo |
| Contratos == bytecode desplegado | Diff entre `deployments/andromeda/*.json` (`metadata.sources[].content`) y `packages/contracts/contracts/**` | **Divergencia confirmada** — ver §2 |
| Parámetros de producción | `deployments/andromeda/*.json` (`address`, `args`), `deploy/10x-*.deploy.ts`, `tasks/deploy.ts` | extraídos sin RPC |
| Dependencias | `yarn install` en la raíz | **BLOQUEADO**: `repo.yarnpkg.com` inaccesible desde el sandbox (corepack no descarga yarn 4.10.3). Se usó `npm` + `solc-js` (ver §6) |
| Submódulo | `l2geth/tests/testdata` | no inicializado (no relevante para este alcance) |

---

## 2. Nota metodológica importante: el bytecode desplegado ≠ HEAD

`deployments/andromeda/{DisputeGameFactory,FaultDisputeGame,LockingPool}.json` embeben el **código fuente completo** con el que se compiló cada contrato (`metadata.sources[].content`). Comparándolo con el árbol actual:

| Contrato | HEAD (`61ef7e9`) | Desplegado en Andrómeda |
|---|---|---|
| `DisputeGameFactory` | `dispute(GameType,bytes,uint256)` con validación `checkBatchBlock` + ventana de disputa | `dispute(GameType,bytes)` **sin** validación de batch |
| | `DISPUTE_TIMEOUT_PERIOD`, `DEFAULT_CHAIN_ID`, `LOCKING_POOL_NAME` | ausentes |
| `MVM_StateCommitmentChain` | `saveDisputedBatch(bytes32,uint256)` | `saveDisputedBatch(bytes32)` (1 argumento) |
| | `earliestDisputedBlockNumber` | **ausente** |
| | `_deleteBatchByChainId` limpia `disputedBatches` | no borra |
| `LockingPool` | `slash(address)` + `timeoutSlash(address)` | `slash(address)` presente, `timeoutSlash` **ausente** |
| `FaultDisputeGame` | `resolve()` llama `saveDisputedBatch(claim, blockNumber)` | `saveDisputedBatch(claim)` |

**Consecuencia:** en el código desplegado, `FaultDisputeGame.resolve()` invoca `saveDisputedBatch(bytes32)` con **un** argumento, pero la `MVM_StateCommitmentChain` desplegada (`0xA2FaAAC9…eEA6`) sí tiene esa firma, así que **no revierte**. En HEAD sí hay un desajuste de firma (`saveDisputedBatch(bytes32,uint256)` llamado con 2 args contra una SCC de 2 args: coincide) y la ruta sigue funcionando.

**La explotación de H-1/H-2 es idéntica en ambas versiones**, porque las líneas responsables (`resolveClaim` línea 803-807, `resolve()` 692-704, `LockingPool.slash` 239-304) son **textualmente idénticas** en HEAD y en el bytecode desplegado (se verificó que el bloque `_distributeBond(disputeCreator(), …)` y el bucle de `slash` no difieren). El PoC se ejecuta contra HEAD, que es lo solicitado, y se documenta aquí que la versión en producción también es vulnerable.

---

## 3. H-1 — `challengeRootL2Block` convierte una afirmación verdadera en una derrota, sin prueba de fraude

### 3.1 Ubicación

| Dato | Valor |
|---|---|
| Repo | `MetisProtocol/mvm` |
| Commit | `61ef7e9a9a1f404505279e1d86f2c26a885bcc86` |
| Archivo | `packages/contracts/contracts/L1/dispute/FaultDisputeGame.sol` |
| Funciones | `initialize()` (L209-290), `challengeRootL2Block()` (L608-668), `resolveClaim()` (L715-824, bloque crítico **L803-807**), `resolve()` (L675-712, bloque **L692-711**) |
| Contrato desplegado | `FaultDisputeGame 0x477f9d1C…6235`, impl. del tipo 0 en `DisputeGameFactory 0xb864eEca…43B3` (proxy `0x1C2f0A08…aeE3`, Andrómeda) |

### 3.2 El bug

`DisputeGameFactory.dispute(gameType, extraData, batchIndex)` acepta `extraData = abi.encode(uint256 l2BlockNumber)` elegido **libremente** por el atacante, dentro del rango del batch (`checkBatchBlock`). `create(gameType, rootClaim, extraData)` no liga ese `extraData` a `rootClaim`.

En `initialize()` sólo existe una cota **inferior**:

```solidity
// FaultDisputeGame.sol:259-262
if (l2BlockNumber() < earliestDisputable.lastL2BlockNumber)
    revert UnexpectedRootClaim(rootClaim());
```

No hay ninguna comprobación de que `rootClaim` corresponda al bloque `l2BlockNumber()`. Por tanto es trivial crear un juego en el que:

* `rootClaim` = `batches().getByChainId(1088, 1)` → **una raíz de estado verdadera y ya comprometida en la SCC** (leída de `ChainStorageContainer`, sin necesidad de fabricarla);
* `l2BlockNumber()` = `250` → un bloque que pertenece al **batch 2**, posterior.

`challengeRootL2Block` exige únicamente (L619-662):

1. `Lib_OVMCodec.hashBatchHeader(_outputRootProof) == rootClaim()` → se satisface con el batch header real;
2. `keccak256(_headerRLP) == latestBlockhash` del `extraData` → se satisface pasando el header real del bloque 200;
3. `blockNumber != l2BlockNumber()` → **200 ≠ 250**, se satisface;
4. `blockNumber ∈ [prevTotalElements+1, prevTotalElements+batchSize]` → 200 está en el batch → se satisface.

Ninguna condición exige que la afirmación sea **falsa**. `challengeRootL2Block` es `external` sin modificador: cualquiera.

Esa llamada activa `l2BlockNumberChallenged = true` y `l2BlockNumberChallenger = msg.sender` (L666-667). Después, `resolveClaim(0, 0)` entra en la rama especial:

```solidity
// FaultDisputeGame.sol:803-807
if (_claimIndex == 0 && l2BlockNumberChallenged) {
    _distributeBond(disputeCreator(), subgameRootClaim);   // bono completo al creador
    subgameRootClaim.counteredBy = l2BlockNumberChallenger;
}
```

y `resolve()` marca `CHALLENGER_WINS` (L683-685) pagando el bono al disputer y llamando a `LockingPool.slash(winner)` (L699) y `saveDisputedBatch(...)` (L707-710).

**Efecto neto:** una raíz de estado **correcta** produce `CHALLENGER_WINS`. El sistema de *fault proofs* está invertido: la honestidad del proponente no lo protege en absoluto.

### 3.3 Condiciones de configuración (código y despliegue reales)

| Parámetro | Valor | Fuente |
|---|---|---|
| `gameType` | `0` (permisionless) | `deploy/105-FaultDisputeGame.deploy.ts:33` |
| `initBond` | `4 ether` | `deploy/105-FaultDisputeGame.deploy.ts:57` (`setInitBond(0, parseEther('4'))`) |
| `maxGameDepth / splitDepth / clockExtension / maxClockDuration` | `73 / 30 / 0 / 86400` | `deploy/105:36-40` |
| `GAME_TYPE` / `L2_CHAIN_ID` | `0` / `1088` | `deploy/105:44` |
| `slashRatio` | `1000` (base 10000 → **10 %**) | `Proxy__LockingPool.json` args `[.., 604800, 1000, ..]` |
| `lockPeriod` | `604800` | idem |
| `FRAUD_PROOF_WINDOW` (SCC) | `604800` | `deploy/020-MVM_StateCommitmentChain.deploy.ts:88-99` |
| `GAME_CREATOR_ROLE` | otorgado al `_owner` en `initialize` (L89) | rol único para `create()`, no para `dispute()` |

El atacante **no necesita ningún rol**: sólo llama a `dispute()` (público) y `challengeRootL2Block()` (público). `create()` lo ejecuta el keeper permisionado que materializa **todas** las peticiones de `dispute()` — es el flujo de diseño en dos pasos, no un requisito de privilegio del atacante.

### 3.4 PoC reproducible

Ver §5. Salida relevante:

```
=============== 3. STEP A - OPEN A GAME ON A TRUE CLAIM ============
    rootClaim          = hash of the batch 1 header (valid state root)
    l2BlockNumber()    = 250 - a block of batch 2
    nothing on-chain ties the root claim to the batch named in extraData
    dispute() ok: public entry point, 4 METIS bond escrowed
    initialize() accepted the mismatched pair; the claim itself is CORRECT

=============== 4. STEP B - challengeRootL2Block() (PERMISSIONLESS) ===
    Lib_OVMCodec.hashBatchHeader(proof) == rootClaim ? true
    submitted header is the genuine header of L2 block 200 != l2BlockNumber() 250
    ACCEPTED. Nothing was disproved: the root claim is the true state root.

=============== 5. STEP C - RESOLVE (ANYONE CAN CALL THESE) ========
    claimData[0].counteredBy = 0x9560Fe67…
    status = 1 (1 = CHALLENGER_WINS against a TRUE claim)
    credit[attacker] = 4.0 METIS
```

---

## 4. H-2 — `LockingPool.slash` confisca el 10 % de **todos** los stakers y lo entrega al destinatario elegido por el atacante

### 4.1 Ubicación

| Dato | Valor |
|---|---|
| Archivo | `packages/contracts/contracts/L1/dispute/LockingPool.sol` |
| Función | `slash(address _recipient)` — **L239-304** (bucle de confiscación L277-293, transferencia L302) |
| Invocador | `FaultDisputeGame.resolve()` L692-704 |
| Contrato desplegado | `Proxy__LockingPool 0x2CA48fF3…DCBb`, impl. `LockingPool 0x5345fCDC…1502` |
| Registro | `Lib_AddressManager 0x918778e8…867d` entrada `FaultProofLockingPool` |

### 4.2 El bug

```solidity
// LockingPool.sol:239-304 (extracto)
function slash(address _recipient) external {
    require(_recipient != address(0), "LockingPool: invalid recipient");
    require(totalLocked > 0, "LockingPool: no tokens to slash");

    IFaultDisputeGame game = IFaultDisputeGame(msg.sender);
    (GameType gameType, Claim rootClaim, bytes memory extraData) = game.gameData();
    (IDisputeGame factoryRegisteredGame, ) = disputeGameFactory.games({
        _gameType: gameType, _rootClaim: rootClaim, _extraData: extraData
    });
    if (address(factoryRegisteredGame) != address(game)) revert UnregisteredGame();
    if (game.status() != GameStatus.CHALLENGER_WINS) revert InvalidGameStatus();

    address[] memory users = depositedSequencers;          // <-- TODOS los stakers
    for (uint256 i; i < usersLength; ) {
        uint256 userBalance = balanceOf[user];
        if (userBalance > 0) {
            uint256 userSlashAmount = (userBalance * slashRatio) / 10000;
            if (userSlashAmount > 0) {
                actualSlashedAmount += userSlashAmount;
                balanceOf[user] = userBalance - userSlashAmount;
            }
        }
        unchecked { ++i; }
    }
    totalLocked -= actualSlashedAmount;
    token.safeTransfer(_recipient, actualSlashedAmount);   // <-- al atacante
}
```

Tres defectos concurrentes:

1. **Conjunto de víctimas incorrecto.** El bono en riesgo en un juego de disputa es el `initBond` (4 METIS) del `disputeCreator`. `slash` ignora por completo quién perdió y confisca a **cada** entrada de `depositedSequencers`, incluidos stakers que no participaron en ninguna disputa.
2. **El destinatario es arbitrario.** `_recipient` no se valida contra el perdedor ni contra el bono; el llamador (el juego) le pasa `winner = claimData[0].counteredBy`, que es el `l2BlockNumberChallenger` — decir, el atacante. El importe transferido es la suma de todas las confiscaciones, no el bono.
3. **Se puede invocar repetidamente.** No hay marca de "juego ya liquidado"; cada juego nuevo vuelve a recorrer el array completo y vuelve a confiscar el 10 % del saldo restante.

`FaultDisputeGame.resolve()` lo ejecuta automáticamente (`try ILockingPool(lockingPool).slash(winner)`), por lo que **el atacante no necesita llamar a `slash`**: basta con resolver el juego que él mismo ganó en H-1. La transferencia es inmediata (`safeTransfer`), sin `lockPeriod` ni desbloqueo — el atacante puede retirar en la misma transacción siguiente.

### 4.3 Condiciones de configuración

`slashRatio = 1000` (10 %) y `lockPeriod = 604800`, ambos del constructor de la implementación desplegada y de `deploy/104-LockingPool.deploy.ts`. Con `slashRatio = 1000` el drenaje por juego es exactamente `0.1 × totalLocked`.

### 4.4 PnL exacto

Sea `T_k` el `totalLocked` antes del juego `k`. Cada juego exitoso:

```
payout_k = T_k × slashRatio / 10000
coste_k  = initBond = 4 METIS
PnL_k    = T_k × 0.1 − 4
T_{k+1}  = T_k − payout_k = 0.9 × T_k
```

Con `T_0 = 1 000 000 METIS` (los tres stakers del PoC):

| Juego | `totalLocked` antes | Payout | Coste | PnL acumulado |
|---|---|---|---|---|
| 1 | 1 000 000 | 100 000 | 4 | +99 996 |
| 2 | 900 000 | 90 000 | 4 | +189 992 |
| 3 | 810 000 | 81 000 | 4 | +270 988 |
| … | … | … | … | … |
| k | 10⁶ · 0.9^(k−1) | 10⁵ · 0.9^(k−1) | 4 | → 10⁶ · (1 − 0.9^k) − 4k |

El ataque es rentable mientras `T_k × 0.1 > 4`, es decir hasta que queden **40 METIS** en el pool. El número de juegos está acotado por `dispute()` (`batchTimes[batch][1] > now − FRAUD_PROOF_WINDOW + DISPUTE_TIMEOUT_PERIOD`, `DisputeGameFactory.sol:128-132`), de modo que el drenaje completo requiere ventanas de disputa sucesivas; con `FRAUD_PROOF_WINDOW = 604800` (7 días) y batches nuevos cada día, es un goteo de ~10 % del pool por batch nuevas, sostenible indefinidamente. Aun en el peor caso de un solo juego, el atacante extrae el 10 % del TVL total arriesgando 4 METIS (apalancamiento 25 000×).

### 4.5 PoC reproducible

```
=============== 2. THREE SEQUENCERS LOCK THEIR METIS ==============
    totalLocked = 1000000.0 METIS | METIS in pool = 1000000.0 METIS
    slashRatio  = 1000 /10000

=============== 6. STEP D - COLLECT ================================
    claimCredit() -> + 4.0 METIS (the 4 METIS bond)
    resolve() already ran LockingPool.slash(attacker):
      totalLocked 1000000.0 METIS -> 900000.0 METIS
    final attacker METIS balance = 100100.0 METIS (slash() transfers immediately, no unlock period)

======================= RESULT =======================
 attacker paid (init bond)     : 4.0 METIS
 attacker received             : 100100.0 METIS
 attacker NET PnL              : 100096.0 METIS
 METIS removed from stakers    : 100000.0 METIS (1000 bps)
 remaining totalLocked         : 900000.0 METIS
```

---

## 5. PoC — instrucciones de reproducción

Todo el material está en `poc-audit/` (dentro del repo, para que persista):

```
poc-audit/
├── compile.js   # compila packages/contracts/contracts/** tal cual (sin modificarlo)
├── harness.js   # EVM local determinista (@ethereumjs/vm 10.1.3, hardfork cancun)
├── poc.js       # el ataque completo, paso a paso
├── MockERC20.sol / Mocks2.sol / Probe.sol   # dobles de test, marcados como tales
├── run.log      # salida registrada de la ejecución final
└── README.md
```

```bash
cd poc-audit
npm install            # solc 0.8.15, ethers 6, @ethereumjs/{vm,common,block,tx,util} 10.1.3
node compile.js        # -> "compiled sources: 136 contracts: 92"
node poc.js            # -> imprime el ataque completo y "PROFITABLE"
```

### 5.1 Contratos reales vs. dobles de test

| Real (compilado de `packages/contracts/contracts`) | Doble de test (justificado) |
|---|---|
| `DisputeGameFactory` | `MockERC20` — METIS es un ERC20 simple; sólo se usan `transfer`/`transferFrom`/`approve`/`balanceOf` |
| `FaultDisputeGame` | `MockProxy` — host ERC1967 para las implementaciones *upgradeable* |
| `LockingPool` | `MockOracle` / `MockMIPS` — la Cannon VM nunca se ejecuta en esta ruta |
| `MVM_StateCommitmentChain` | `MockProposerRegistry` — devuelve `getProposer(1088)`, misma interfaz que `iMVM_ProposerRegistry` |
| `ChainStorageContainer` | |
| `L1ChugSplashProxy` (plantilla del proxy de producción de la SCC) | |
| `DelayedWMetis`, `MetisConfig`, `Lib_AddressManager` | |

### 5.2 Shim de entorno (único, documentado en la salida)

`DisputeGameFactory.dispute()` guarda `blockhash(block.number - 1)` como marcador anti-duplicado (`:150`) y `create()` lo rechaza si es cero (`:184`). La VM local no tiene bloques ancestros, por lo que `BLOCKHASH()` devuelve `0` en todos los bloques (verificado con `Probe.sol` y pruebas dedicadas). El PoC escribe ese campo directamente:

```
[harness shim] anti-duplicate marker l1Head written (dev chain: no BLOCKHASH)
```

Es la única manipulación de estado fuera de la API pública de los contratos; **ninguna línea de lógica de negocio se altera**. En una L1 real el marcador es siempre distinto de cero y el shim desaparece.

### 5.3 Efectos secundarios observados

```
=============== 7. SIDE EFFECTS ====================================
    SCC.disputedBatches[rootClaim] = true
    SCC.earliestDisputedBlockNumber = 101
```

`MVM_StateCommitmentChain.saveDisputedBatch` marca el batch como disputado y baja `earliestDisputedBlockNumber`. `L1CrossDomainMessenger._verifyStateRootProofByChainId` (`contracts/L1/messaging/L1CrossDomainMessenger.sol:484-486`) exige `prevTotalElements + batchSize < earliestDisputedBlockNumber`, por lo que **todas las salidas L2→L1 probadas contra batches que terminen en o después de ese número quedan rechazadas** — un bloqueo de retiros que se suma al robo. Esto es un DoS persistente que agrava el impacto, reportado aquí como efecto de H-1 (no como hallazgo independiente, al no ser un DoS *temporal*).

---

## 6. Registro de auditoría

### 6.1 Repositorios clonados y commit hash

| Repo | Commit | Estado |
|---|---|---|
| `https://github.com/MetisProtocol/mvm` (workspace, rama `develop`) | `61ef7e9a9a1f404505279e1d86f2c26a885bcc86` (2026-10-17) | clonado, `diff -rq` contra upstream: **sin diferencias** |
| `https://github.com/MetisProtocol/mvm` (`/tmp/metis_up`, `--depth 1`) | idéntico | usado para la verificación de integridad |
| `https://github.com/ethereum-optimism/optimism` (referencia, `--depth 1`) | tags `op-contracts/v1.3.0`, `v1.4.0`, `v1.6.0` | usado para diff de `PreimageOracle` y de `FaultDisputeGame` |

Submódulo `l2geth/tests/testdata`: **no inicializado** (no afecta al alcance de contratos).

### 6.2 Archivos de configuración / despliegue inspeccionados

* `packages/contracts/deployments/andromeda/` — `Lib_AddressManager.json`, `Proxy__LockingPool.json`, `LockingPool.json`, `DisputeGameFactory.json`, `Proxy__DisputeGameFactory.json`, `FaultDisputeGame.json`, `Proxy__MVM_StateCommitmentChain.json`, `MVM_StateCommitmentChain_for_verification_only.json`, `ChainStorageContainer-SCC-batches.json`, `DelayedWMetis.json`, `Proxy__DelayedWMetis.json`, `MetisConfig.json`, `PreimageOracle.json`, `MIPS.json`, `MVM_ProposerRegistry.json`, `solcInputs/*.json`
* `packages/contracts/deploy/` — `000-Lib_AddressManager`, `003-OVM_ChainStorageContainer_scc_batches`, `010/011/012`, `019-Proxy__MVM_StateCommitmentChain`, `020-MVM_StateCommitmentChain`, `030-set-addresses`, `100-MIPS`, `101-DisputeGameFactory`, `102-MetisConfig`, `103-DelayedWMetis`, `104-LockingPool`, `105-FaultDisputeGame`, `106-PermissionedDisputeGame`, `107-MVM_ProposerRegistry`
* `packages/contracts/tasks/deploy.ts` (parámetros CLI `faultDisputeTimeout`, `sccFraudProofWindow`, `ovmProposerAddress`, …)
* `packages/contracts/src/hardhat-deploy-ethers.ts` (semántica de `deployAndRegister` / `setStorage`)
* `bug-bounty.md` (Immunefi, Critical hasta USD 1 000 000, exige PoC)

### 6.3 Parámetros de producción extraídos (sin RPC)

| Contrato | Dirección (Andrómeda) | Parámetros |
|---|---|---|
| `Lib_AddressManager` | `0x918778e825747a892b17C66fe7D24C618262867d` | owner = `mvmMetisManager` |
| `Proxy__LockingPool` | `0x2CA48fF3bBC59Bff859543E63233116ecdA3DCBb` | `[addrMgr, METIS 0x9E32…ed8e, lockPeriod 604800, slashRatio 1000, SCC, MetisConfig 0x2aA4…57Ff]` |
| `LockingPool` (impl.) | `0x5345fCDCF5449a40df030798C195603d27691502` | |
| `DisputeGameFactory` (impl.) | `0xb864eEca2a047058Eb1e28e43FEAEBE8F38843B3` | constructor `[METIS]` en el código desplegado |
| `Proxy__DisputeGameFactory` | `0x1C2f0A08762f0aD4598fB5de8f9D6626a4e4aeE3` | `[owner 0x5345…1502]` |
| `FaultDisputeGame` | `0x477f9d1C…6235` | `[type 0, prestate 0x03c4…3805, 73, 30, 0, 86400, MIPS, DelayedWMetis, addrMgr, 1088]`, initBond `4 ether` |
| `Proxy__MVM_StateCommitmentChain` | `0xA2FaAAC9120c1Ff75814F0c6DdB119496a12eEA6` | `[impl 0x001088E3…5751]`, slots: 0 addrMgr, 1 `604800`, 2 `604800`, 3 `1088` |
| `PreimageOracle` | `0x789a6428…0BBbC` | `[126000, 86400]` |

### 6.4 Tests / PoCs ejecutados

```bash
$ cd /home/user/mvm/poc-audit
$ npm install
$ node compile.js
compiled sources: 136 contracts: 92

$ node poc.js > run.log 2>&1 ; echo exit=$?
exit=0
```

Salida completa en `poc-audit/run.log`; extracto en §3.4, §4.5 y §5.3.

Pruebas auxiliares durante el desarrollo (mismo harness): verificación de que `BLOCKHASH()` devuelve cero en toda la VM; `Probe.sol` para validar el decodificado RLP del índice 8 del header; comprobación de `Lib_OVMCodec.hashBatchHeader` contra el batch header recuperado del evento `StateBatchAppended`.

### 6.5 Repos bloqueados / no accesibles

| Recurso | Estado |
|---|---|
| `repo.yarnpkg.com` (descarga de yarn 4.10.3 vía corepack) | **bloqueado** → `yarn install` del monorepo imposible; se usó `npm` + `solc-js` |
| `registry.npmjs.org`, `pypi.org`, `github.com`, `codeload.github.com`, `api.github.com` | accesibles |
| RPC / nodos de Andrómeda o L1 | **no usados** (por requisito); todos los parámetros salen de `deployments/`, `deploy/`, `tasks/` |
| `l2geth/tests/testdata` (submódulo) | no inicializable, irrelevante para este alcance |

---

## 7. Invariantes que se verifican y se rompen

| # | Invariante esperado | Estado |
|---|---|---|
| I-1 | Un juego de disputa sólo termina en `CHALLENGER_WINS` si se demostró que el `rootClaim` es falso | **ROTO** (H-1: `challengeRootL2Block` gana sin prueba) |
| I-2 | `l2BlockNumber()` de un juego debe ser el bloque de L2 al que se refiere su `rootClaim` | **ROTO** (H-1: `initialize()` sólo comprueba una cota inferior) |
| I-3 | El bono en riesgo es el del `disputeCreator` / `claimant` del juego | **ROTO** (H-1: se paga al `disputeCreator` incluso sin que haya perdido; H-2: se cobra a terceros ajenos) |
| I-4 | `LockingPool.slash` sólo afecta al participante que perdió la disputa | **ROTO** (H-2: recorre `depositedSequencers` completo) |
| I-5 | `_recipient` de `slash` debe ser un acreedor definido por el protocolo | **ROTO** (H-2: es el `counteredBy`, elegido por el atacante) |
| I-6 | Un batch marcado como disputado no puede volver a disputarse | **CUMPLE** (`disputedBatches`, `ClaimAlreadyResolved`) — pero se usa como arma de DoS |
| I-7 | `create()` sólo materializa peticiones de `dispute()` registradas | **CUMPLE** (`NoDisputeGameRequests`) |
| I-8 | `create()` está restringido a `GAME_CREATOR_ROLE` | **CUMPLE** (`onlyRole`) — no protege, porque `dispute()` es público |

## 8. Rutas verificadas y descartadas como críticas

Revisadas y **no** reportadas (por ser código muerto, requerir privilegios, ser dust o DoS temporal):

* `PermissionedDisputeGame`: `onlyAuthorized` en `step`/`move`, `initialize` exige `tx.origin == PROPOSER` — no es la ruta por defecto (tipo 0).
* `LockingPool.timeoutSlash`: **sin llamador** en el repo (código muerto).
* `L1CrossDomainMessenger._verifyXDomainMessage*` / `_sendXDomainMessage`: no referenciadas (muertas).
* `L2CrossDomainMessenger.sendMessageViaChainId`: cuerpo vacío (quema `msg.value`), pero sólo en L2 y sin beneficiario.
* `MVM_ChainConfig.setConfig`: write-once sin control de acceso — impacto acotado, no permite mover fondos.
* `OVM_DeployerWhitelist`: abierto si `owner == 0` — no hay ruta de fondos de terceros.
* `Lib_ResolvedDelegateProxy`: `delegatecall` sin owner en el fallback — sin efecto económico directo.
* `PreimageOracle.initLPP` / `squeezeLPP`: acotados por `msg.value` y `CHALLENGE_PERIOD`, sin PnL explotable.
* `MVM_Verifier.verify2` / `distributeReward`: reparto proporcional, sin ventaja permissionless clara.
* `L1StandardBridge.finalizeETHWithdrawal` con pool único y `fee <= msg.value` (quema de ETH): griefing/dust.
* `L2StandardBridge.finalizeDeposit` con ERC165 fallido → `DepositFailed` y fondos atrapados: requiere token no conforme, no da PnL al atacante.
* `DisputeGameFactory.create()` con `blockhash(block.number-1) == 0` (batch de un solo bloque): DoS temporal no reportado.

---

## 9. Recomendaciones

**H-1**
1. En `initialize()`, exigir que `l2BlockNumber()` sea el último bloque del batch cuyo header es `rootClaim`, y que `extraData` decodifique a ese mismo `rootClaim` (ligar `rootClaim` ↔ `l2BlockNumber` ↔ batch).
2. En `challengeRootL2Block`, además de `blockNumber != l2BlockNumber()`, exigir que el header sea **prueba de inconsistencia**: que el bloque realmente disputado sea el del `l2BlockNumber()` declarado y que el header presentado corresponda al bloque del batch que se dice disputar.
3. En `resolveClaim(0)`, el pago debe ir al actor que demostró el fraude, no ciegamente a `disputeCreator()`; y `disputeCreator()` debe haber depositado un bono en riesgo.

**H-2**
1. `slash` debe confiscar **exclusivamente** el bono del `claimant` que perdió el juego (`_bonded.bond`), no un porcentaje del pool.
2. Eliminar el parámetro `_recipient` controlado por el llamador; derivar el acreedor del propio juego y verificar que es el `claimant` perdedor.
3. Añadir una marca de liquidación por juego para impedir dobles confiscaciones, y acotar `actualSlashedAmount <= bond_esperado`.
4. Mientras se corrige: `slashRatio` debería ser 0 y `FaultProofLockingPool` no debería estar registrado en el `Lib_AddressManager` (con `lockingPool == address(0)` el `resolve()` omite la llamada, `FaultDisputeGame.sol:694`).
