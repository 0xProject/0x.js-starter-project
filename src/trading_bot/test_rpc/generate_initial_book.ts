import {
    ZeroEx,
    ZeroExConfig,
    OrderFillRequest,
} from '0x.js';
import {
    FeesRequest,
    FeesResponse,
    HttpClient,
    Order,
    OrderbookRequest,
    OrderbookResponse,
    SignedOrder,
} from '@0xproject/connect';
import { BigNumber } from '@0xproject/utils';
import * as Web3 from 'web3';

const mainAsync = async () => {
    // Provider pointing to local TestRPC on default port 8545
    const provider = new Web3.providers.HttpProvider('http://localhost:8545');

    // Instantiate 0x.js instance
    const zeroExConfig: ZeroExConfig = {
        networkId: 50, // testrpc
    };
    const zeroEx = new ZeroEx(provider, zeroExConfig);

    // Instantiate relayer client pointing to a local server on port 3000
    const relayerApiUrl = 'http://localhost:3000/v0';
    const relayerClient = new HttpClient(relayerApiUrl);

    // Get exchange contract address
    const EXCHANGE_ADDRESS = await zeroEx.exchange.getContractAddress();

    // Get token information
    const wethTokenInfo = await zeroEx.tokenRegistry.getTokenBySymbolIfExistsAsync('WETH');
    const zrxTokenInfo = await zeroEx.tokenRegistry.getTokenBySymbolIfExistsAsync('ZRX');

    // Check if either getTokenBySymbolIfExistsAsync query resulted in undefined
    if (wethTokenInfo === undefined || zrxTokenInfo === undefined) {
        throw new Error('could not find token info');
    }

    // Get token contract addresses
    const WETH_ADDRESS = wethTokenInfo.address;
    const ZRX_ADDRESS = zrxTokenInfo.address;

    // Get all available addresses
    const addresses = await zeroEx.getAvailableAddressesAsync();

    // Get the first address, this address is preloaded with a ZRX balance from the snapshot
    const zrxOwnerAddress = addresses[0];

    // Assign other addresses as WETH owners
    const wethOwnerAddresses = addresses.slice(1);

    // Set WETH and ZRX unlimited allowances for all addresses
    const setZrxAllowanceTxHashes = await Promise.all(addresses.map(address => {
        return zeroEx.token.setUnlimitedProxyAllowanceAsync(ZRX_ADDRESS, address);
    }));
    const setWethAllowanceTxHashes = await Promise.all(addresses.map(address => {
        return zeroEx.token.setUnlimitedProxyAllowanceAsync(WETH_ADDRESS, address);
    }));
    await Promise.all(setZrxAllowanceTxHashes.concat(setWethAllowanceTxHashes).map(tx => {
        return zeroEx.awaitTransactionMinedAsync(tx);
    }));

    // There is a bug on test_rpc that errors on trades that bring a token balance to 0
    const eth = ZeroEx.toBaseUnitAmount(new BigNumber('1'), wethTokenInfo.decimals);
    const ethTxnHash = await zeroEx.etherToken.depositAsync(WETH_ADDRESS, eth, zrxOwnerAddress);
    await zeroEx.awaitTransactionMinedAsync(ethTxnHash);

    // Deposit ETH and generate WETH tokens for each address in wethOwnerAddresses
    const ethToConvert = ZeroEx.toBaseUnitAmount(new BigNumber(10), wethTokenInfo.decimals);
    const wethDepositTxHashes = await Promise.all(wethOwnerAddresses.map(address => {
        return zeroEx.etherToken.depositAsync(WETH_ADDRESS, ethToConvert, address);
    }));

    // Send 1000 ZRX from zrxOwner to all other addresses
    const zrxDepositTxHashes = await Promise.all(wethOwnerAddresses.map(async (address, index) => {
        const zrxToTransfer =  ZeroEx.toBaseUnitAmount(new BigNumber(1000), zrxTokenInfo.decimals);
        return zeroEx.token.transferAsync(ZRX_ADDRESS, zrxOwnerAddress, address, zrxToTransfer);
    }));

    await Promise.all(wethDepositTxHashes.concat(zrxDepositTxHashes).map(tx => {
        return zeroEx.awaitTransactionMinedAsync(tx);
    }));

    // Generate and submit orders with increasing ZRX/WETH exchange rate
    await Promise.all(wethOwnerAddresses.map(async (address, index) => {
        // Programmatically determine the exchange rate based on the index of address in wethOwnerAddresses
        const exchangeRate = (index + 1) * 10; // ZRX/WETH

        var makerTokenAddress: string, takerTokenAddress: string;
        var makerTokenAmount: BigNumber, takerTokenAmount: BigNumber;
        const wethAmount = new BigNumber(Math.floor(Math.random() * 10) + 1)
        if (Math.random() > 0.5) {
            makerTokenAddress = WETH_ADDRESS;
            takerTokenAddress = ZRX_ADDRESS;

            makerTokenAmount = ZeroEx.toBaseUnitAmount(wethAmount, wethTokenInfo.decimals);
            takerTokenAmount = makerTokenAmount.mul(exchangeRate);
        } else {
            makerTokenAddress = ZRX_ADDRESS;
            takerTokenAddress = WETH_ADDRESS;

            takerTokenAmount = ZeroEx.toBaseUnitAmount(wethAmount, wethTokenInfo.decimals);
            makerTokenAmount = takerTokenAmount.mul(exchangeRate);
        }

        // Generate fees request for the order
        const ONE_HOUR_IN_MS = 3600000;
        const feesRequest: FeesRequest = {
            exchangeContractAddress: EXCHANGE_ADDRESS,
            maker: address,
            taker: ZeroEx.NULL_ADDRESS,
            makerTokenAddress,
            takerTokenAddress,
            makerTokenAmount,
            takerTokenAmount,
            expirationUnixTimestampSec: new BigNumber(Date.now() + ONE_HOUR_IN_MS),
            salt: ZeroEx.generatePseudoRandomSalt(),
        };

        // Send fees request to relayer and receive a FeesResponse instance
        const feesResponse: FeesResponse = await relayerClient.getFeesAsync(feesRequest);

        // Combine the fees request and response to from a complete order
        const order: Order = {
            ...feesRequest,
            ...feesResponse,
        };

        // Create orderHash
        const orderHash = ZeroEx.getOrderHashHex(order);

        // Sign orderHash and produce a ecSignature
        const ecSignature = await zeroEx.signOrderHashAsync(orderHash, address, false);

        // Append signature to order
        const signedOrder: SignedOrder = {
            ...order,
            ecSignature,
        };

        // Submit order to relayer
        await relayerClient.submitOrderAsync(signedOrder);
    }));
};

mainAsync().catch(console.error);