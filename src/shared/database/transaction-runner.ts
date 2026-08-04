import { Inject, Injectable } from '@nestjs/common';
import {
  PrismaClientService,
  type PrismaTransactionHost,
} from './prisma.service';

declare const transactionContextBrand: unique symbol;

export const PrismaTransactionClientService = Symbol(
  'PrismaTransactionClientService',
);

export interface TransactionContext {
  readonly [transactionContextBrand]: true;
}

@Injectable()
export class TransactionRunner {
  private readonly clients = new WeakMap<TransactionContext, unknown>();

  constructor(
    @Inject(PrismaClientService)
    private readonly prisma: PrismaTransactionHost,
  ) {}

  async run<T>(work: (context: TransactionContext) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (client) => {
      const context = Object.freeze({}) as TransactionContext;
      this.clients.set(context, client);
      try {
        return await work(context);
      } finally {
        this.clients.delete(context);
      }
    });
  }

  async [PrismaTransactionClientService]<T>(
    context: TransactionContext,
    work: (client: unknown) => Promise<T>,
  ): Promise<T> {
    const client = this.clients.get(context);
    if (client === undefined) {
      throw new Error('Expected an active TransactionContext');
    }
    return work(client);
  }
}
