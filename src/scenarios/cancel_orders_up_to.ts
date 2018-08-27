import { assetDataUtils, BigNumber, ContractWrappers, Order } from '0x.js';
import { Web3Wrapper } from '@0xproject/web3-wrapper';

import { NETWORK_ID, NULL_ADDRESS, ONE_MINUTE, TEN_MINUTES, ZERO } from '../constants';
import { providerEngine } from '../contracts';
import { PrintUtils } from '../print_utils';

/**
 * In this scenario, the maker creates and signs many orders selling ZRX for WETH.
 * The maker is able to cancel all any number of these orders effeciently by using cancelOrdersUpTo.
 */
export async function scenario(): Promise<void> {
    PrintUtils.printScenario('Cancel Orders Up To');
    // Initialize the ContractWrappers, this provides helper functions around calling
    // contracts on the blockchain
    const contractWrappers = new ContractWrappers(providerEngine, { networkId: NETWORK_ID });
    // Initialize the Web3Wraper, this provides helper functions around calling
    // account information, balances, general contract logs
    const web3Wrapper = new Web3Wrapper(providerEngine);
    const [maker, taker] = await web3Wrapper.getAvailableAddressesAsync();
    const zrxTokenAddress = contractWrappers.exchange.getZRXTokenAddress();
    const etherTokenAddress = contractWrappers.etherToken.getContractAddressIfExists();
    if (!etherTokenAddress) {
        throw new Error('Ether Token not found on this network');
    }
    const printUtils = new PrintUtils(
        web3Wrapper,
        contractWrappers,
        { maker, taker },
        { WETH: etherTokenAddress, ZRX: zrxTokenAddress },
    );
    printUtils.printAccounts();

    // the amount the maker is selling in maker asset
    const makerAssetAmount = new BigNumber(100);
    // the amount the maker is wanting in taker asset
    const takerAssetAmount = new BigNumber(10);
    // 0x v2 uses asset data to encode the correct proxy type and additional parameters
    const makerAssetData = assetDataUtils.encodeERC20AssetData(zrxTokenAddress);
    const takerAssetData = assetDataUtils.encodeERC20AssetData(etherTokenAddress);

    // Set up the Order and fill it
    const randomExpiration = new BigNumber(Date.now() + TEN_MINUTES);
    const exchangeAddress = contractWrappers.exchange.getContractAddress();

    // Rather than using a random salt, we use an incrementing salt value.
    // When combined with cancelOrdersUpTo, all lesser values of salt can be cancelled
    // This allows the maker to cancel many orders with one on-chain transaction

    // Create the order
    const order1: Order = {
        exchangeAddress,
        makerAddress: maker,
        takerAddress: NULL_ADDRESS,
        senderAddress: NULL_ADDRESS,
        feeRecipientAddress: NULL_ADDRESS,
        expirationTimeSeconds: randomExpiration,
        salt: new BigNumber(Date.now() - TEN_MINUTES),
        makerAssetAmount,
        takerAssetAmount,
        makerAssetData,
        takerAssetData,
        makerFee: ZERO,
        takerFee: ZERO,
    };

    const order2: Order = {
        ...order1,
        salt: new BigNumber(Date.now() - ONE_MINUTE),
    };

    const order3: Order = {
        ...order1,
        salt: new BigNumber(Date.now()),
    };

    // Fetch and print the order info
    let order1Info = await contractWrappers.exchange.getOrderInfoAsync(order1);
    let order2Info = await contractWrappers.exchange.getOrderInfoAsync(order2);
    let order3Info = await contractWrappers.exchange.getOrderInfoAsync(order3);
    printUtils.printOrderInfos({ order1: order1Info, order2: order2Info, order3: order3Info });

    // Maker cancels all orders before and including order2, order3 remains valid
    const targetOrderEpoch = order2.salt;
    const txHash = await contractWrappers.exchange.cancelOrdersUpToAsync(targetOrderEpoch, maker);
    const txReceipt = await printUtils.awaitTransactionMinedSpinnerAsync('cancelOrdersUpTo', txHash);
    printUtils.printTransaction('cancelOrdersUpTo', txReceipt, [['targetOrderEpoch', targetOrderEpoch.toString()]]);
    // Fetch and print the order info
    order1Info = await contractWrappers.exchange.getOrderInfoAsync(order1);
    order2Info = await contractWrappers.exchange.getOrderInfoAsync(order2);
    order3Info = await contractWrappers.exchange.getOrderInfoAsync(order3);
    printUtils.printOrderInfos({ order1: order1Info, order2: order2Info, order3: order3Info });

    // Stop the Provider Engine
    providerEngine.stop();
}

void (async () => {
    try {
        if (!module.parent) {
            await scenario();
        }
    } catch (e) {
        console.log(e);
        providerEngine.stop();
    }
})();