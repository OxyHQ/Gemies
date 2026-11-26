import {
  type Entity,
  type EntityOptions,
  entity,
  type RecordSource,
  type RecordSourceOptions,
  type RecordView,
  type Skip,
  skip,
  source,
  useRecord,
} from '@oxy.so/bloom-data';

/**
 * A server answer held whole, under the key of the read that returned it.
 *
 * Conversations are records by id (`Conversations`). Most other reads of the runtime return one
 * value that is not: an agent's profile, the person's collections, a thread's search hits, the
 * accounts they connected. Such an answer is one record whose id is the read's key, so it is read,
 * refreshed, shared between callers and dropped with its account's store like any other record.
 * An answer the account holds once is under `ACCOUNT`: every account has its own store.
 */
export interface Answer<T> {
  /** The key of the read that returned it. */
  readonly id: string;
  readonly value: T;
}

export interface AnswerSourceOptions<A extends unknown[], T>
  extends Omit<RecordSourceOptions<A, Answer<T>>, 'load' | 'index' | 'put'> {
  /** The answer; it is held under `key(...args)`. */
  load: (request: { readonly signal: AbortSignal }, ...args: NoInfer<A>) => Promise<T>;
  /**
   * Copy the answers to the account's durable store; a `version` drops the stored answers when it
   * changes (bump it with any change to the answer's shape).
   */
  persist?: EntityOptions<Answer<T>>['persist'];
}

/** A record source whose records are the answers of `load`, one per key. `type` names its entity. */
export interface AnswerSource<A extends unknown[], T> extends RecordSource<A, Answer<T>> {
  readonly entity: Entity<Answer<T>>;
}

export function answerSource<A extends unknown[], T>(
  type: string,
  { load, persist, ...options }: AnswerSourceOptions<A, T>,
): AnswerSource<A, T> {
  return source(entity<Answer<T>>(type, { id: (answer) => answer.id, persist }), {
    ...options,
    load: async (request, ...args) => ({
      id: options.key(...args),
      value: await load(request, ...args),
    }),
  });
}

/**
 * Observes an answer source for `args` (or nothing, with `skip`) and returns the answer as the
 * view's `value`. An answer held from an earlier read of the key (a disk copy, another screen's)
 * shows at once while the read runs.
 */
export function useAnswer<A extends unknown[], T>(
  answers: AnswerSource<A, T>,
  ...args: A | [Skip]
): RecordView<T> {
  const view = useRecord(answers, ...args);
  const observed = args[0] !== skip;
  const value = view.value?.value;
  return {
    ...view,
    value,
    isLoading: observed && value === undefined && view.status !== 'error',
    isFetching: view.fetchStatus === 'fetching' || (observed && view.status === 'idle'),
  };
}
