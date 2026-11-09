# Parámetros de producción leídos de axelar-contract-deployments @ 97fe2f1
# (axelar-chains-config/info/mainnet.json) — extraídos SIN RPC

## ITS Hub (CosmWasm, chain axelar)
address: axelar1aqcj54lzz0rk22gvqgcn8fr5tx4rzwdv5wv5j9dmnacgefvd7wzsy2j2mr
codeId: 63   version: 1.3.2
truncation config (líneas 4630-4652):
  stellar : maxUintBits=127  maxDecimalsWhenTruncating=255
  xrpl    : maxUintBits=256  maxDecimalsWhenTruncating=255
  hedera  : maxUintBits=64   maxDecimalsWhenTruncating=6
  solana  : maxUintBits=64   maxDecimalsWhenTruncating=6

## ITS edge contract (EVM, misma dirección en todas las EVM)
address: 0xB5FB4BE02232B1bBA4dC8f81dc24C26980dE9e3C   salt "ITS v2.1.1" version 2.1.1
factory: 0x83a93500d23Fbc3e82B410aD07A6a9F7A0670D66
chain nueva (arc/robinhood): ITS 0x48d39Cc5F03f572E4cc2813E846cd0D3a63c0a4a

## Gateway / GasService (Ethereum)
AxelarGateway  0x4F4495243837681061C4743b74B3eEdf548D56A5 (impl 0x99B5FA03a5ea4315725c43346e55a6A6fbd94098)
AxelarGasService 0x2d5d7d31F671F86C782533cc367F14109a082712 (impl 0xcb5C784DCf8FF342625DbC53B356ed0Cbb0EBB9b)

## Otras VMs
Sui ITS      itsAUdHnV2K99ppbM6d6WUDac8MD54RAE7dUKHnw1Eg
Solana ITS   itsAUdHnV2K99ppbM6d6WUDac8MD54RAE7dUKHnw1Eg
Stellar ITS  CBDBMIOFHGWUFRYH3D3STI2DHBOWGDDBCRKQEUB4RGQEBVG74SEED6C6
XRPL ITS     rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw

## Versiones de las librerías fijadas por ITS v2.2.0 (package.json)
@axelar-network/axelar-cgp-solidity      6.4.0
@axelar-network/axelar-gmp-sdk-solidity  6.0.6
