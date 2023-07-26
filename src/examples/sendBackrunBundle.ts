import { JsonRpcProvider, formatEther, keccak256 } from 'ethers'
import { Mutex } from "async-mutex"

// lib
import MevShareClient, { BundleParams, IPendingTransaction } from '..'
import { getProvider, initExample } from './lib/helpers'
import { sendTx, setupTxExample } from './lib/sendTx'
import { AsyncArray } from './lib/async'

const NUM_TARGET_BLOCKS = 3

/**
 * Generate a transaction to backrun a pending mev-share transaction and send it to mev-share.
 */
const sendTestBackrunBundle = async (provider: JsonRpcProvider, pendingTx: IPendingTransaction, mevshare: MevShareClient, targetBlock: number) => {
    // send bundle w/ (basefee + 100)gwei gas fee
    const {tx, wallet} = await setupTxExample(provider, BigInt(1e8) * BigInt(1e3), "im backrunniiiiing")
    const backrunTx = {
        ...tx,
        nonce: tx.nonce ? tx.nonce + 1 : undefined,
    }
    const bundle = [
        {hash: pendingTx.hash},
        {tx: await wallet.signTransaction(backrunTx), canRevert: false},
    ]
    console.log(`sending backrun bundles targeting next ${NUM_TARGET_BLOCKS} blocks...`)
    const bundleParams: BundleParams = {
        inclusion: {
            block: targetBlock,
            maxBlock: targetBlock + NUM_TARGET_BLOCKS,
        },
        body: bundle,
    }
    const backrunResult = await mevshare.sendBundle(bundleParams)
    return {
        bundleParams,
        backrunResult,
    }
}

/** Async handler which backruns an mev-share tx with another basic example tx. */
const handleBackrun = async (
    pendingTx: IPendingTransaction,
    provider: JsonRpcProvider,
    mevshare: MevShareClient,
    pendingMutex: Mutex,
    pendingTxHashes: AsyncArray<string>,
): Promise<void> => {
    console.log("pendingTxHashes", await pendingTxHashes.get())
    if (!(await pendingTxHashes.includes(pendingTx.hash))) {
        // ignore txs we didn't send. they break the bundle (nonce error) bc we're using one account to do everything
        return
    } else {
        console.log("pending tx", pendingTx)
    }
    const targetBlock = await provider.getBlockNumber() + 1
    const {
        bundleParams,
        backrunResult,
    } = await sendTestBackrunBundle(provider, pendingTx, mevshare, targetBlock)
    console.log("backrun result", backrunResult)

    // watch future blocks for backrun tx inclusion
    for (let i = 0; i < NUM_TARGET_BLOCKS; i++) {
        const currentBlock = targetBlock + i
        if (!pendingMutex.isLocked()) {
            // mutex was released by another handler, so we can exit
            break
        }
        console.log(`tx ${pendingTx.hash} waiting for block`, currentBlock)
        // stall until target block is available
        while (await provider.getBlockNumber() < currentBlock) {
            await new Promise(resolve => setTimeout(resolve, 6000))
        }

        // check for inclusion of backrun tx in target block
        const backrunTx = (bundleParams.body[1] as any).tx
        if (backrunTx) {
            const checkTxHash = keccak256(backrunTx)
            const receipt = await provider.getTransactionReceipt(checkTxHash)
            if (receipt?.status === 1) {
                console.log(`bundle included! (found tx ${receipt.hash})`)

                // simulate for funzies
                const simOptions = {
                    parentBlock: receipt.blockNumber - 1,
                }
                const simResult = await mevshare.simulateBundle(bundleParams, simOptions)
                console.log(`simResult (simOptions=${JSON.stringify(simOptions, null, 2)})`, simResult)
                console.log(`profit: ${formatEther(simResult.profit)} ETH`)
                
                // release mutex so the main thread can exit
                pendingMutex.release()
                break
            } else {
                console.warn(`backrun tx ${checkTxHash} not included in block ${currentBlock}`)
            }
        }
    }
    await pendingTxHashes.filter(hash => hash !== pendingTx.hash)
    console.log("dropped target tx", pendingTx.hash)
}

/**
 * Sends a tx on every block and backruns it with a simple example tx.
 *
 * Continues until we land a backrun, then exits.
 */
const main = async () => {
    const provider = getProvider()
    const {mevshare} = await initExample(provider)

    // used for tracking txs we sent. we only want to backrun txs we sent, 
    // since we're using one account and incrementing the nonce of the bundle's 2nd tx
    const pendingTxHashes = new AsyncArray<string>()

    // used for blocking this thread until the handler is done processing
    const pendingMutex = new Mutex()
    
    // listen for txs
    const txHandler = mevshare.on("transaction", async (pendingTx: IPendingTransaction) => {
        await handleBackrun(pendingTx, provider, mevshare, pendingMutex, pendingTxHashes)
    })
    console.log("listening for transactions...")

    await pendingMutex.acquire()
    // send a tx that we can backrun on every block
    // tx will be backrun independently by the `handleBackrun` callback
    const blockHandler = await provider.on("block", async (blockNum) => {
        if (await pendingTxHashes.length() === 0) {
            const res = await sendTx(provider, {logs: true, contractAddress: true, calldata: true, functionSelector: true}, blockNum + NUM_TARGET_BLOCKS)
            console.log("sent tx", res)
            pendingTxHashes.push(res)
        }
    })

    // will block until one of the handlers releases the mutex
    await pendingMutex.acquire()
    pendingMutex.release()

    // stop listening for txs
    txHandler.close()
    await blockHandler.removeAllListeners()
}

main().then(() => {
    process.exit(0)
})
