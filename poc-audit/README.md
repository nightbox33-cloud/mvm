# PoC — Metis `mvm` fault proofs (commit `61ef7e9`)

Ataque **end-to-end** contra los contratos reales del repo, compilados **sin modificar**.

## Ejecución

```bash
npm install
node compile.js     # compila ../packages/contracts/contracts/** -> build/
node poc.js         # ejecuta el ataque; salida registrada en run.log
```

Requiere `node >= 18`. Dependencias: `solc@0.8.15`, `ethers@6`,
`@ethereumjs/{vm,common,block,tx,util}@10.1.3`.

## Estructura

| Fichero | Contenido |
|---|---|
| `compile.js` | Compila `../packages/contracts/contracts/**` tal cual; sólo normaliza los `import` (solc-js no soporta remappings). Excluye `WETH9.sol` (pragma `0.4.x`) y `test-*`. |
| `harness.js` | EVM local determinista: despliegue, transacciones firmadas de verdad, `view`, minado. Sin forks ni RPC. |
| `poc.js` | El ataque completo: despliegue con parámetros de producción, batches honestos, depósitos de terceros, apertura del juego, contador permissionless, resolución, cobro y contabilidad del PnL. |
| `MockERC20.sol`, `Mocks2.sol` | Dobles de test (METIS, proxy ERC1967, Cannon, proposer registry). Marcados como no auditados. |
| `Probe.sol` | Utilidad de depuración: decodifica el `blockNumber` (índice 8) de un header RLP con el `Lib_RLPReader` real. |
| `run.log` | Salida de la ejecución registrada. |

## Contratos reales ejercitados

`DisputeGameFactory`, `FaultDisputeGame`, `LockingPool`, `MVM_StateCommitmentChain`,
`ChainStorageContainer`, `L1ChugSplashProxy` (plantilla de proxy de producción),
`DelayedWMetis`, `MetisConfig`, `Lib_AddressManager`.

## Shim de entorno

La VM local no tiene bloques ancestros, así que `BLOCKHASH()` devuelve `0`.
`DisputeGameFactory.dispute()` guarda `blockhash(block.number-1)` como marcador
anti-duplicado (`:150`) y `create()` lo rechaza si es cero (`:184`). El PoC escribe
ese campo directamente (única escritura de storage fuera de la API pública; en una
L1 real el valor es siempre no nulo). No se altera ninguna lógica de negocio.

## Resultado esperado

```
attacker paid (init bond)     : 4.0 METIS
attacker received             : 100100.0 METIS
attacker NET PnL              : 100096.0 METIS
METIS removed from stakers    : 100000.0 METIS (1000 bps)
>>> PROFITABLE: 4 METIS risked, 100096.0 METIS of third-party funds taken
```

Detalles completos del análisis en `../AUDIT-METIS-MVM.md`.
