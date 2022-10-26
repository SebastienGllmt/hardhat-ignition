import setupDebug from "debug";
import { ethers } from "ethers";

import {
  GasProvider,
  IgnitionSigner,
  SignersProvider,
  TransactionsProvider,
} from "types/providers";
import { sleep } from "utils/sleep";
import { TxSender } from "utils/tx-sender";

import type { TransactionOptions } from "./types";

export interface IContractsService {
  deploy(
    deployTransaction: ethers.providers.TransactionRequest,
    txOptions?: TransactionOptions
  ): Promise<string>;

  call(
    unsignedTx: ethers.PopulatedTransaction,
    txOptions?: TransactionOptions
  ): Promise<string>;
}

export interface ContractsServiceProviders {
  web3Provider: ethers.providers.Web3Provider;
  signersProvider: SignersProvider;
  transactionsProvider: TransactionsProvider;
  gasProvider: GasProvider;
}

export class ContractsService implements IContractsService {
  private _debug = setupDebug("ignition:services:contracts-service");

  constructor(
    private _providers: ContractsServiceProviders,
    private _txSender: TxSender,
    private _options: { pollingInterval: number }
  ) {}

  public async deploy(
    deployTransaction: ethers.providers.TransactionRequest,
    txOptions?: TransactionOptions
  ): Promise<string> {
    this._debug("Deploying contract");
    const signer = await this._providers.signersProvider.getDefaultSigner();

    return this._sendTx(signer, deployTransaction, txOptions);
  }

  public async call(
    unsignedTx: ethers.PopulatedTransaction,
    txOptions?: TransactionOptions
  ): Promise<string> {
    this._debug("Calling method of contract");
    const signer = await this._providers.signersProvider.getDefaultSigner();

    return this._sendTx(signer, unsignedTx, txOptions);
  }

  private async _sendTx(
    signer: IgnitionSigner,
    tx: ethers.providers.TransactionRequest,
    txOptions?: TransactionOptions
  ): Promise<string> {
    if (txOptions?.gasLimit !== undefined) {
      tx.gasLimit = ethers.BigNumber.from(txOptions.gasLimit);
    }

    if (txOptions?.gasPrice !== undefined) {
      tx.gasPrice = ethers.BigNumber.from(txOptions.gasPrice);
    }

    let blockNumberWhenSent =
      await this._providers.web3Provider.getBlockNumber();
    const txIndexAndHash = await this._txSender.send(
      signer,
      tx,
      blockNumberWhenSent
    );

    const txIndex = txIndexAndHash[0];
    let txHash = txIndexAndHash[1];

    let txSent = tx;
    let retries = 0;
    while (true) {
      const currentBlockNumber =
        await this._providers.web3Provider.getBlockNumber();

      if (await this._providers.transactionsProvider.isConfirmed(txHash)) {
        break;
      }

      if (blockNumberWhenSent + 5 <= currentBlockNumber) {
        if (retries === 4) {
          throw new Error("Transaction not confirmed within max retry limit");
        }

        const txToSend = await this._bump(txHash, signer, txSent, txHash);

        blockNumberWhenSent =
          await this._providers.web3Provider.getBlockNumber();
        txHash = await this._txSender.sendAndReplace(
          signer,
          txToSend,
          blockNumberWhenSent,
          txIndex
        );

        txSent = txToSend;
        retries++;
      }

      await sleep(this._options.pollingInterval);
    }

    return txHash;
  }

  private async _bump(
    _txHash: string,
    _signer: IgnitionSigner,
    previousTxRequest: ethers.providers.TransactionRequest,
    previousTxHash: string
  ): Promise<ethers.providers.TransactionRequest> {
    const previousTx = await this._providers.web3Provider.getTransaction(
      previousTxHash
    );
    const newEstimatedGasPrice =
      await this._providers.gasProvider.estimateGasPrice();

    if (previousTx.gasPrice !== undefined) {
      // Increase 10%, and add 1 to be sure it's at least rounded up
      const newGasPrice = ethers.BigNumber.from(previousTx.gasPrice)
        .mul(110000)
        .div(100000)
        .add(1);

      return {
        ...previousTxRequest,
        nonce: previousTx.nonce,
        gasPrice: newEstimatedGasPrice.gt(newGasPrice)
          ? newEstimatedGasPrice
          : newGasPrice,
      };
    } else if (
      previousTx.maxFeePerGas !== undefined &&
      previousTx.maxPriorityFeePerGas !== undefined
    ) {
      const newMaxFeePerGas = ethers.BigNumber.from(previousTx.maxFeePerGas)
        .mul(110000)
        .div(100000)
        .add(1);

      const newMaxPriorityFeePerGas = ethers.BigNumber.from(
        previousTx.maxPriorityFeePerGas
      )
        .mul(110000)
        .div(100000)
        .add(1);

      return {
        ...previousTxRequest,
        nonce: previousTx.nonce,
        maxFeePerGas: newMaxFeePerGas,
        maxPriorityFeePerGas: newMaxPriorityFeePerGas,
      };
    }

    throw new Error(
      `Transaction doesn't have gasPrice or maxFeePerGas/maxPriorityFeePerGas`
    );
  }
}
