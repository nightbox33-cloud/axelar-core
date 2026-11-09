# Auditoría de seguridad — Axelar Network (fundación `axelarnetwork`)

**Fecha:** 2026-11-09
**Alcance:** repositorios de producción de la fundación Axelar: nodo/cliente Cosmos (`axelar-core`), EVM Gateway/ITS/SDK y su despliegue real en 30+ chains, contratos CosmWasm (Amplifier: gateway, router, ITS Hub, multisig), Move (Sui) y predeployments de Hyperliquid.
**Método:** clonado de repos + lectura de config de despliegue real + compilación y ejecución **local** de las suites de test del propio repo + tests de auditoría nuevos ejecutados contra el clon. **Sin RPC** (restricción respetada: todo el estado se instancia localmente).

---

## 1. Veredicto

> **No crítico en código.**

No se encontró ninguna vulnerabilidad que cumpla los 4 criterios (bug real, *permissionless*, alcanzable con la configuración de producción del repo, y verificable localmente produciendo Output > Input a costa de fondos de terceros).

Sí se identificaron **3 hallazgos válidos de severidad alta/media** que **no** alcanzan "crítico" según la regla del encargo (requieren un rol privilegiado, o el impacto es pérdida de fondos del propio atacante, no de terceros). Se documentan abajo con su trazado exacto, porque en un protocolo puente cada capacidad de un rol operativo es superficie de riesgo real y conviene tenerla registrada.

---

## 2. Hallazgos

### H-1 (Alta, requiere rol) — La `OPERATOR` role de ITS puede reescribir el binding `deployer` de HyperCore de **cualquier** interchain token de terceros

**Ubicación exacta**
- Repo: `axelarnetwork/interchain-token-service` @ `0f4b03706c79ed9c364edd080aca4ae23a7e3642` (release `v2.2.0`)
- `contracts/hyperliquid/HyperliquidInterchainTokenService.sol:53-59` — `updateTokenDeployer(...) external onlyOperatorOrOwner`
- `contracts/InterchainTokenService.sol:176-182` — `onlyOperatorOrOwner` acepta **cualquier** dirección con `Roles.OPERATOR`
- `contracts/InterchainTokenService.sol:669-675` — `_setup` hace `_addOperator(operator)`
- `contracts/hyperliquid/HyperliquidInterchainToken.sol:48-50` + `HyperliquidDeployer.sol:16,33-38` — `updateDeployer` escribe `sload/sstore(keccak256('HyperCore deployer'))`, el slot que HyperCore usa para enlazar un spot asset con su ERC20 en HyperEVM

**Bug en código**
`updateTokenDeployer` valida únicamente `onlyOperatorOrOwner`. No comprueba que el llamante sea minter del token, ni que el token manager haya aprobado el cambio, ni que el token sea "de Hyperliquid" más allá de existir su token manager. La función reescribe el slot de almacenamiento que **HyperCore** interpreta como la identidad del deployer del spot asset (`https://hyperliquid.gitbook.io/hyperliquid-docs/.../hypercore-less-than-greater-than-hyperevm-transfers`). El dueño real del token (minter + operator del `TokenManager`) **no es consultado ni puede vetarlo**, y el cambio no emite nada en el token salvo el evento de ITS.

**Condiciones de configuración (leídas del repo)**
- La chain debe ser una deployment Hyperliquid de ITS (contrato `HyperliquidInterchainTokenService`, tokens `HyperliquidInterchainToken`); el propio `scripts/deploy.js:97-101` selecciona esos artefactos cuando `chainName` contiene `hyperliquid`.
- La dirección atacante debe tener `Roles.OPERATOR` (o ser `owner()`). En el despliegue canónico el operator es una EOA operativa (el owner es gobernanza). Es decir: **basta comprometer la clave del operator, o que el operator sea malicioso**, sin pasar por gobernanza/timelock.

**Verificación reproducible (ejecutada)**
`audit/test/HyperliquidDeployerRoleBoundary.audit.js` (incluido en este repo) — copiado a `test/audit/` del clon de ITS:

```
$ npx hardhat test test/audit/HyperliquidDeployerRoleBoundary.audit.js
  AUDIT Hyperliquid deployer binding
    ✔ ITS OPERATOR role can rewrite the HyperCore deployer of a third-party token it is not a minter of (1779ms)
  1 passing
```

Salida intermedia del mismo test en su variante verbosa:

```
isOperator(owner)         = true
isOperator(operator)      = false
token minter              = 0x3C44…93BC
manager.isOperator(minter)= true
deployer before           = 0x0000…0000
deployer after (by ITS operator) = 0x15d3…6A65
token.isMinter(ITS owner) = false      <-- el llamante NO es minter del token
```

**Por qué NO es crítico según la regla del encargo**
El rol `OPERATOR` es privilegiado: no es *permissionless*. El encargo sólo admite roles permissionless o con impacto económico superior al bond. No hay prueba de que este rol sea permissionless en el repo (se asigna en `setup` desde `deployInterchainTokenService(ownerAddress, operatorAddress)`).

**Impacto real si se ejerce:** un token interchain de un tercero en Hyperliquid queda con un `deployer` distinto del que desplegó su spot asset en HyperCore → los transfers HyperCore↔HyperEVM de ese token quedan desalineados (fondos de terceros inmovilizados o acreditados al actor equivocado). Es un vector de compromiso de integración, no un robo directo demostrado.

**Mitigación:** exigir en `updateTokenDeployer` consentimiento del token (p.ej. que `msg.sender` sea el `operator` del token manager / minter), o mover la función detrás de `onlyOwner` + timelock, o exigir prueba firmada por el minter análoga a `approveDeployRemoteInterchainToken`.

---

### H-2 (Media) — `TokenHandler.giveToken` incrementa `flowIn` con el importe **solicitado**, no con el realmente entregado (tokens fee-on-transfer / deflacionarios)

**Ubicación exacta**
- `interchain-token-service` @ `0f4b037`, `contracts/TokenHandler.sol:33-56`
- Concretamente `:39` `ITokenManager(tokenManager).addFlowIn(amount);` y `:50` `amount = _transferTokenFromWithFee(...)`, `:158-160` `diff = balanceOf(to) - balanceBefore; return diff < amount ? diff : amount;`

**Bug en código**
En la ruta `LOCK_UNLOCK_FEE`, la entrega real puede ser menor que `amount` (fee on transfer). El contador de flujo de entrada (`FlowLimit._addFlowIn`, `FlowLimit.sol:106-137`) se incrementa con el valor **antes** del ajuste por fee. Consecuencias:
1. El límite de flujo (rate-limit anti-drenaje de 6 h, `EPOCH_TIME` en `FlowLimit.sol:18`) se consume de más → un atacante puede agotar la ventana de entrada de un token fee-on-transfer pagando fees pequeños a un tercero, causando DoS temporal de entradas legítimas para ese token.
2. El `amount` devuelto al ejecutor de express (`_processInterchainTransferPayload`/`_expressExecute`) y el evento `InterchainTransferReceived` reportan un valor distinto al realmente acreditado.

**Condiciones de configuración:** el token manager debe ser `LOCK_UNLOCK_FEE` (tipo 4) con un token que cobre fee en transfer; esto es una configuración soportada explícitamente por ITS (existe `test/TestFeeOnTransferToken.sol` en el repo).

**Verificación:** trazado matemático sobre el código clonado (`diff < amount` ⇒ `credited = amount - fee`; `addFlowIn` recibe `amount`), y la lógica es alcanzable desde `execute()` (entrada hub) para cualquier mensaje `MESSAGE_TYPE_INTERCHAIN_TRANSFER`.

**Por qué NO es crítico:** no hay Output > Input para el atacante; el fee lo cobra el propio token y el atacante lo paga. El efecto es DoS temporal de un token concreto (excluido explícitamente por el encargo) más un desfase de contabilidad de flujo.

**Mitigación:** mover `addFlowIn` a después del ajuste (`_transferTokenFromWithFee` primero, `addFlowIn(amountAjustado)` después).

---

### H-3 (Baja) — Off-by-one en el flow limit de Sui ITS

**Ubicación exacta:** `axelarnetwork/axelar-cgp-sui` @ `d820f4914ae0cc03ea690ac4aa39e383ade77513`, `move/interchain_token_service/sources/types/flow_limit.move:41` y `:52` (`assert!(... < flow_limit + ...)`), y `interfaces` de uso en `types/coin_management.move:100-122`.

**Bug:** el límite es exclusivo (`<`) mientras que la referencia EVM (`FlowLimit.sol:124`, `netFlow > flowLimit_` revierte) es inclusiva (`<=` admitido). Diferencia de 1 unidad atómica entre chains: no explotable (dust, no escalable), pero rompe la paridad de semántica entre implementaciones del mismo módulo y puede confundir el modelado de riesgo de un token con `maxUintBits`/decimales asimétricos.

**Además:** `CoinManagement.dust: u256` (`coin_management.move:28`) se inicializa y se descarta en `destroy` (`:173`) sin usarse nunca — campo muerto, no bug.

**Por qué NO es crítico:** pérdida máxima de 1 unidad mínima por operación, bloqueada además por mínimos y por el propio límite.

---

## 3. Rutas críticas verificadas y descartadas (con razonamiento sobre el clon)

Selección de los puntos que **parecen** bugs y fueron descartados tras trazarlos contra el código real:

| # | Superficie | Por qué se descartó |
|---|---|---|
| 1 | **ITS Hub, invariante de supply con truncado de decimales** (`axelar-amplifier` @ `3e96bbe`, `contracts/interchain-token-service/src/contract/execute/mod.rs:254-270` y `interceptors.rs:228-280`) — `subtract_supply_amount` debita el importe **fuente** y `add_supply_amount` acredita el importe **destino** ya truncado. | El acuñado en destino lo hace el token manager con el importe truncado ⇒ acuñado total ≤ supply del hub (sobre-colateralizado, no insuficiente) ⇒ **no hay insolvencia explotable**. El desfase (hasta `10^d − 1` por transferencia, `d = dec_src − dec_dst`) sólo puede **disminuir** el supply del hub, y la única palanca (`ModifySupply`) es `Elevated, Specific(operator)`. No permissionless. *Nota para el informe de gobernanza:* el parámetro `maxDecimalsWhenTruncating` de producción está en `255` para stellar/xrpl (fichero `axelar-contract-deployments/axelar-chains-config/info/mainnet.json:4635-4640`), es decir **sin truncado** en la práctica. |
| 2 | **Link/canonical con minter custom (`TokenDeploymentType::CustomMinter` ⇒ `TokenSupply::Untracked`, `state.rs:130-137`)** | El supply no rastreado se inicializa en `Untracked` y sólo puede fijarse por el `operator` (`modify_supply`, `execute/mod.rs:440-478`). Si no se fija, el hub **rechaza** el primer transfer de vuelta (`checked_sub` sobre `Untracked` ⇒ `Untracked`, y `TokenSupplyInvariantViolated` en el sentido contrario) ⇒ falla cerrada, no abierta. |
| 3 | **Gateway EVM `execute()`** (`axelar-cgp-solidity` @ `a4367a0`, `AxelarGateway.sol:512-571`) | Marca `_setCommandExecuted(commandId, true)` **antes** del `call` y revierte a `false` si falla ⇒ sin replay. `chainId` validado contra `block.chainid`. `_burnTokenFrom` (`:761-781`) sólo mueve saldo del `sender` o del `depositAddress` del propio token, con `safeTransferFrom`/`burnFrom`. |
| 4 | **Gas service / estimación on-chain** (`axelar-gmp-sdk-solidity` @ `30196ca`, `gas-estimation/InterchainGasEstimation.sol`) | Las constantes L1 (`scalarPrecision`, `blobBaseFeeScalar`) están **hardcodeadas como cotas superiores** (0.0015 y 0.9), por lo que la estimación sobre-paga en lugar de sub-pagar; el remanente lo reclama el `refundAddress`, no un tercero. `_setGasInfo` sólo desde `onlyCollector` (`AxelarGasService.sol:402-412`). |
| 5 | **Multisig ponderado** (`BaseWeightedMultisig.sol`) | `_validateSignatures`: cada firma debe coincidir con el **siguiente** operador en orden estrictamente ascendente (`signerIndex` monótono) ⇒ no se puede reutilizar el peso de un mismo firmante; `_validateSigners` prohíbe duplicados, peso 0 y exige `totalWeight ≥ threshold`; `ECDSA.recover` rechaza `s` alto, `v∉{27,28}` y `address(0)`. Sin maleabilidad ni replay entre epochs (`epochBySignersHash`). |
| 6 | **Router/gateway CosmWasm** (`axelar-amplifier` @ `3e96bbe`, `router/src/contract.rs:107-127,174-206`) | `validate_msgs` verifica el `source_chain` de cada mensaje contra la gateway registrada del emisor, exige `msg_id` con el formato de esa chain y respeta freeze de entrada/salida. `find_gateway_address` sólo acepta axelarnet-gateway o una gateway registrada (más `Nexus` para chains externas). |
| 7 | **Nodo — confirmación de eventos EVM** (`axelar-core` @ `b992e71`, `x/evm/keeper/vote_handler.go:198-235`, `chainKeeper.go:610-632`) | `HandleResult` resuelve la chain **desde el metadata del poll** y rechaza resultados cuyo `voteEvents.Chain` no coincida; `SetConfirmedEvent` rechaza re-confirmar un event id ya existente. Sin ruta para inyectar eventos de otra chain. |
| 8 | **Nodo — voting** (`x/vote/keeper/msg_server.go:28-80`) | Sólo el proxy de un validador del snapshot puede votar; el `poll.Vote()` exige que el votante esté en el snapshot del poll; el tally es por peso y el `Threshold` por defecto es 2/3 (`x/vote/types/params.go`). |
| 9 | **Nodo — IBC/lockable assets** (`x/nexus/keeper/lockable_asset.go:33-205`) | `toICS20` reconstruye el path (`{path}/{base}`) y **compara con `parsedDenom.Path()`** antes de usarlo como clave de escrow ⇒ no se puede redirigir el escrow a otro denom. `GetEscrowAddress` (`x/nexus/exported/types.go:446-461`) documenta el invariante de estabilidad de valor. |
| 10 | **Nodo — reward pools** (`x/reward/keeper/reward_pool.go:83-127`) | `ReleaseRewards` sólo puede invocarlo el flujo de votación para validadores del snapshot; el acumulador borra el registro (**suma**, no asignación) y es idempotente vía `defer p.ClearRewards`. |
| 11 | **ITS EVM — anti-squatting de token managers** (`TokenHandler.sol:67-91`, `Create3Fixed.sol:28-45`) | `tokenOnly=true` en `takeToken` impide que un `TokenManager` falso (mismo `tokenId`, desplegado por OTRO `TokenManagerDeployer`) queme tokens ajenos: el `msg.sender` debe ser el token. `_create3` revierte `AlreadyDeployed` si ya hay código. |
| 12 | **ITS EVM — validación de Hub y de replay** (`InterchainTokenService.sol:166-172,447-460,926-948`) | `onlyItsHub` fija `sourceChain == "axelar"` **y** `sourceAddress == itsHubAddress` (inmutable); `_decodeHubMessage` revierte salvo `MESSAGE_TYPE_RECEIVE_FROM_HUB` y exige `isTrustedChain(originalSourceChain)`. Más `gateway.validateContractCall(...)` ⇒ ejecución única. |
| 13 | **Proxies / upgrades** (`Upgradable.sol:44-79`, `Proxy.sol:26-53`) | `upgrade` valida `contractId` y `codehash`, y es `onlyOwner`; `setup` es `onlyProxy`; implementation fija `Ownable(address(1))` y marca `_initialize()` en el constructor para bloquear `init()` sobre la implementation. |
| 14 | **Hyperliquid `deployer` slot** (`HyperliquidDeployer.sol`) | `DEPLOYER_SLOT = keccak256('HyperCore deployer')` no colisiona con slots de `ERC20`/`Minter`/`RolesBase` (todos `keccak256(...)` con prefijos distintos) ni con `INITIALIZED_SLOT` del token. Verificado en el test de H-1 (el storage queda coherente). |

---

## 4. Registro de auditoría

### 4.1 Organizaciones enumeradas (GitHub API, sin RPC)

- `axelarnetwork` (org oficial, 102 repos públicos) — enumerada en 4 páginas vía `gh api /orgs/axelarnetwork/repos`.
- `nightbox33-cloud/axelar-core` — fork del repo auditado; **verificado byte-a-byte idéntico** al upstream: `git diff --stat FETCH_HEAD HEAD` vacío, `merge-base == b992e711016e08568b958868b1091aa296a0e93f`. Por tanto la auditoría de `axelar-core` aplica al upstream real.
- Espacios adicionales identificados y usados como fuente de despliegue: `axelar-configs`, `axelar-contract-deployments`, `axelar-docs`, `axelarscan-api` (no era necesario su clonado completo: la config de producción vive en `axelar-contract-deployments/axelar-chains-config/info/`).

### 4.2 Repos clonados (commit exacto)

| Repo | Commit | Fecha | Nota |
|---|---|---|---|
| `axelar-core` | `b992e711016e08568b958868b1091aa296a0e93f` | 2026-10-16 | igual al upstream `main` (fork sin divergencia) |
| `axelar-gmp-sdk-solidity` | `30196ca7cb9479fd5f79f0668523bd2a488093ed` | 2026-06-02 | tag `v6.2.0` |
| `axelar-cgp-solidity` | `a4367a0006ab5852fe705e7e4cd15ee6d6ea6bef` | 2026-10-20 | `v6.5.0` |
| `interchain-token-service` | `0f4b03706c79ed9c364edd080aca4ae23a7e3642` | 2026-10-06 | `v2.2.0` + 7 commits |
| `axelar-contract-deployments` | `97fe2f1ff3027eaadb6c82a70c0b9d42774be82f` | 2026-11-06 | incluye `axelar-chains-config/info/mainnet.json` |
| `axelar-amplifier` | `3e96bbec024a958f826526df5848d136c554ca43` | 2026-11-01 | ITS Hub, gateway, router, multisig |
| `axelar-cgp-sui` | `d820f4914ae0cc03ea690ac4aa39e383ade77513` | 2026-05-27 | Move / Sui |
| `axelar-amplifier-solana`, `axelar-amplifier-stellar`, `axelar-cgp-aptos` | (clonados; sin hallazgos) | — | `axelar-cgp-aptos` está **archivado** |

**Bloqueados / no accesibles:** ninguno de los repos públicos. Todos los repos de la fundación son públicos (`gh api /orgs/axelarnetwork/repos` no devuelve privados accesibles), por lo que **no se declara cobertura incompleta por repos privados**. Limitaciones de entorno sí existentes (ver 4.6).

### 4.3 Ficheros de configuración / despliegue inspeccionados

- `axelar-contract-deployments/axelar-chains-config/info/mainnet.json` — 32 chains; direcciones ITS/Gateway por chain; `InterchainTokenService` (axelar) `codeId 63`, versión `1.3.2`; `AxelarnetGateway` `codeId 22`; `XrplVotingVerifier`; parámetros de truncado `InterchainTokenService.{stellar,xrpl,hedera,solana}.{maxUintBits,maxDecimalsWhenTruncating}` (líneas 4630-4652).
- Direcciones destacadas leídas (no consultadas por RPC, por restricción): ITS EVM `0xB5FB4BE02232B1bBA4dC8f81dc24C26980dE9e3C` (Ethereum y resto de EVM, `salt: "ITS v2.1.1"`, `version: 2.1.1`), ITS Factory `0x83a93500d23Fbc3e82B410aD07A6a9F7A0670D66`, Gateway Ethereum `0x4F4495243837681061C4743b74B3eEdf548D56A5`, GasService `0x2d5d7d31F671F86C782533cc367F14109a082712`, ITS Hub (CosmWasm) `axelar1aqcj54lzz0rk22gvqgcn8fr5tx4rzwdv5wv5j9dmnacgefvd7wzsy2j2mr`, ITS Sui `itsAUdHnV2K99ppbM6d6WUDac8MD54RAE7dUKHnw1Eg`, ITS Stellar `CBDBMIOFHGWUFRYH3D3STI2DHBOWGDDBCRKQEUB4RGQEBVG74SEED6C6`, ITS XRPL `rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw`, chains `arc`/`robinhood` (ITS `0x48d39Cc5F03f572E4cc2813E846cd0D3a63c0a4a`).
- `hardhat.config.js` de los 4 repos Solidity (versiones de solc, overrides de bytecode fijo).
- `package.json`/`package-lock.json` (versiones de dependencias: `@axelar-network/axelar-cgp-solidity@6.4.0`, `axelar-gmp-sdk-solidity@6.0.6`).
- `axelar-contract-deployments/evm/*.js` (deploy-its, gateway, gas-service, hyperliquid, governance).
- `x/vote/types/params.go` (threshold por defecto 2/3), `x/evm/types/types.go`.
- Move: `interchain_token_service/sources/types/{flow_limit,coin_management,coin_data}.move`, `axelar_gateway/sources/{gateway,auth}.move`.

### 4.4 Herramientas y ejecuciones (comandos y salidas)

```
# Compilación OFFLINE (sin red a binaries.soliditylang.org / go.dev / static.rust-lang.org):
# se instalaron los paquetes npm solc 0.8.9/0.8.21/0.8.23/0.8.27 y se poblo el cache
# soljson de Hardhat con wrappers (/tmp/solccli.js) + list.json.

axelar-gmp-sdk-solidity : npx hardhat compile -> "Compiled 149 Solidity files successfully (evm target: london)"
                          npx hardhat test    -> 371 passing
interchain-token-service: npx hardhat compile -> "Compiled 114 Solidity files successfully (evm target: london)"
                          npx hardhat test    -> 322 passing
                          npx hardhat test test/audit/HyperliquidDeployerRoleBoundary.audit.js -> 1 passing  (test NUEVO de auditoría)
axelar-cgp-solidity     : npx hardhat compile -> "Compiled 67 Solidity files successfully (evm target: london)"
                          npx hardhat test    -> 208 passing
Slither (vía venv):       slither . --hardhat-ignore-compile --print human-summary
                          -> 303 contracts analizados, 96 detectores, "0 result(s) found"
Semgrep:                  intentado (p/solidity, r/solidity.security) -> BLOQUEADO por red (semgrep.dev TLS);
                          sustituido por lectura manual + Slither + tests locales.
Foundry / Echidna / Medusa / Halmos / Hevm / cargo-fuzz / Kani / Trident / Move Prover:
                          NO INSTALABLES (foundry.paradigm.xyz, github release-assets, static.rust-lang.org,
                          go.dev, deb.debian.org y binaries.soliditylang.org devuelven 000/SSL cerrado).
                          Sustituidos por: suites de test nativas del repo + tests de auditoría en Hardhat
                          (EVM real, no fork) + trazado matemático sobre el codigo clonado.
RPC:                      no usado (0 consultas), segun requisito.
```

Entorno: Node v22.22.3, npm (registry accesible), Python 3.11 + slither/semgrep vía pip, 2 vCPU / 3 GB RAM.

### 4.5 Tests de auditoría añadidos (persistidos en este repo)

- `audit/test/HyperliquidDeployerRoleBoundary.audit.js` — demuestra H-1 (pasa).

### 4.6 Limitaciones declaradas

1. **Sin RPC** (por requisito): no se verificó TVL/estado en vivo; todos los hallazgos se sostienen sobre el código + config del repo, que es lo que exige la "regla de oro".
2. **Toolchain de fuzzing formal no disponible** por bloqueo de red (Foundry/Echidna/Medusa/Halmos/Hevm/Kani/cargo-fuzz/Trident/Move Prover/Kani). La verificación se hizo con las suites del propio repo (901 tests verdes en total: 371+322+208) y con un test de auditoría nuevo; el análisis cuantitativo de invariantes se hizo por trazado matemático explícito.
3. **Go toolchain (`go.dev`) y Rust toolchain (`static.rust-lang.org`) no descargables** ⇒ la suite `go test ./x/...` de `axelar-core` y `cargo test` de `axelar-amplifier` **no se ejecutaron** en esta sesión. El análisis de esos módulos fue lectura de código + trazado de rutas. Es la única parte del encargo que queda pendiente de ejecución de tests; se recomienda correr:
   `go test ./x/evm/... ./x/nexus/... ./x/vote/... ./x/axelarnet/... ./x/reward/...`
   y `cargo test -p interchain-token-service -p router -p gateway`.
4. No se auditó en profundidad `axelar-amplifier-solana`/`-stellar`/`cgp-aptos` (código de edge, menor TVL percibido); quedan clonados para una segunda pasada.

---

## 5. Recomendaciones (orden de prioridad)

1. **H-1:** atar `updateTokenDeployer` al consentimiento del token (minter/operator del token manager) o moverlo a `onlyOwner` + timelock. Es la única capacidad encontrada que permite a un rol operativo alterar unilateralmente el binding de un activo de terceros en HyperCore.
2. **H-2:** mover `addFlowIn` después del ajuste por fee en `TokenHandler.giveToken`.
3. **H-3:** alinear el comparador de flow limit de Sui con el de EVM (`<=` vs `<`) para mantener paridad semántica.
4. Revisar el parámetro `maxDecimalsWhenTruncating = 255` en producción: desactiva de facto el truncado, lo que hoy es conservador, pero deja el vector de desfase de supply del hub abierto si en el futuro se habilita un valor bajo.
