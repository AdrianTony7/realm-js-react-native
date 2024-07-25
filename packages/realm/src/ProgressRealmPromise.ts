////////////////////////////////////////////////////////////////////////////
//
// Copyright 2022 Realm Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
////////////////////////////////////////////////////////////////////////////

import { binding } from "../binding";
import { assert } from "./assert";
import { TimeoutError } from "./errors";
import { flags } from "./flags";
import { indirect } from "./indirect";
import { type Configuration, validateConfiguration } from "./Configuration";
import { OpenRealmBehaviorType, OpenRealmTimeOutBehavior } from "./app-services/SyncConfiguration";
import { SubscriptionSetState } from "./app-services/BaseSubscriptionSet";
import { type ProgressNotificationCallback, isEstimateProgressNotificationCallback } from "./app-services/SyncSession";
import { PromiseHandle } from "./PromiseHandle";
import { TimeoutPromise } from "./TimeoutPromise";
import type { Realm } from "./Realm";

type OpenBehavior = {
  openBehavior: OpenRealmBehaviorType;
  timeOut?: number;
  timeOutBehavior?: OpenRealmTimeOutBehavior;
};

function determineBehavior(config: Configuration, realmExists: boolean): OpenBehavior {
  const { sync, openSyncedRealmLocally } = config;
  if (!sync || openSyncedRealmLocally) {
    return { openBehavior: OpenRealmBehaviorType.OpenImmediately };
  } else {
    const configProperty = realmExists ? "existingRealmFileBehavior" : "newRealmFileBehavior";
    const configBehavior = sync[configProperty];
    if (configBehavior) {
      const { type, timeOut, timeOutBehavior } = configBehavior;
      if (typeof timeOut !== "undefined") {
        assert.number(timeOut, "timeOut");
      }
      return { openBehavior: type, timeOut, timeOutBehavior };
    } else {
      return {
        openBehavior: OpenRealmBehaviorType.DownloadBeforeOpen,
        timeOut: 30 * 1000,
        timeOutBehavior: OpenRealmTimeOutBehavior.ThrowException,
      };
    }
  }
}

export class ProgressRealmPromise implements Promise<Realm> {
  /** @internal */
  private static instances = new Set<binding.WeakRef<ProgressRealmPromise>>();
  /**
   * Cancels all unresolved `ProgressRealmPromise` instances.
   * @internal
   */
  public static cancelAll() {
    for (const promiseRef of ProgressRealmPromise.instances) {
      promiseRef.deref()?.cancel();
    }
    ProgressRealmPromise.instances.clear();
  }
  /** @internal */
  private task: binding.AsyncOpenTask | null = null;
  /** @internal */
  private listeners = new Set<ProgressNotificationCallback>();
  /** @internal */
  private handle = new PromiseHandle<Realm>();
  /** @internal */
  private timeoutPromise: TimeoutPromise<Realm> | null = null;
  /**
   * Token used for unregistering the progress notifier.
   * @internal
   */
  private notifierToken: binding.Int64 | null = null;

  /** @internal */
  constructor(config: Configuration) {
    if (flags.ALLOW_CLEAR_TEST_STATE) {
      ProgressRealmPromise.instances.add(new binding.WeakRef(this));
    }
    try {
      validateConfiguration(config);
      // Calling `Realm.exists()` before `binding.Realm.getSynchronizedRealm()` is necessary to capture
      // the correct value when this constructor was called since `binding.Realm.getSynchronizedRealm()`
      // will open the realm. This is needed when calling the Realm constructor.
      const realmExists = indirect.Realm.exists(config);
      const { openBehavior, timeOut, timeOutBehavior } = determineBehavior(config, realmExists);
      if (openBehavior === OpenRealmBehaviorType.OpenImmediately) {
        const realm = new indirect.Realm(config);
        this.handle.resolve(realm);
      } else if (openBehavior === OpenRealmBehaviorType.DownloadBeforeOpen) {
        const { bindingConfig } = indirect.Realm.transformConfig(config);

        // Construct an async open task
        this.task = binding.Realm.getSynchronizedRealm(bindingConfig);
        // If the promise handle gets rejected, we should cancel the open task
        // to avoid consuming a thread safe reference which is no longer registered
        this.handle.promise.catch(() => this.task?.cancel());

        this.createTimeoutPromise(config, { openBehavior, timeOut, timeOutBehavior });

        this.task
          .start()
          .then(async (tsr) => {
            const realm = new indirect.Realm(config, {
              internal: binding.Helpers.consumeThreadSafeReferenceToSharedRealm(tsr),
              // Do not call `Realm.exists()` here in case the realm has been opened by this point in time.
              realmExists,
            });
            if (config.sync?.flexible && !config.openSyncedRealmLocally) {
              const { subscriptions } = realm;
              if (subscriptions.state === SubscriptionSetState.Pending) {
                await subscriptions.waitForSynchronization();
              }
            }
            return realm;
          })
          .then(this.handle.resolve, (err) => {
            assert.undefined(err.code, "Update this to use the error code instead of matching on message");
            if (err instanceof Error && err.message === "Sync session became inactive") {
              // This can happen when two async tasks are opened for the same Realm and one gets canceled
              this.rejectAsCanceled();
            } else {
              this.handle.reject(err);
            }
          });
        this.notifierToken = this.task.registerDownloadProgressNotifier(this.emitProgress.bind(this));
      } else {
        throw new Error(`Unexpected open behavior '${openBehavior}'`);
      }
    } catch (err) {
      if (this.notifierToken !== null) {
        this.task?.unregisterDownloadProgressNotifier(this.notifierToken);
        this.notifierToken = null;
      }
      this.handle.reject(err);
    }
  }

  /**
   * Cancels the download of the Realm
   * If multiple `ProgressRealmPromise` instances are in progress for the same Realm, then canceling one of them
   * will cancel all of them.
   */
  cancel(): void {
    this.cancelAndResetTask();
    this.timeoutPromise?.cancel();
    if (this.notifierToken !== null) {
      this.task?.unregisterDownloadProgressNotifier(this.notifierToken);
      this.notifierToken = null;
    }
    // Clearing all listeners to avoid accidental progress notifications
    this.listeners.clear();
    // Tell anything awaiting the promise
    this.rejectAsCanceled();
  }

  /**
   * Register to receive progress notifications while the download is in progress.
   * @param callback Called multiple times as the client receives data.
   */
  progress(callback: ProgressNotificationCallback): this {
    this.listeners.add(callback);
    // TODO: Is the manual triggering necessary? It was meant to mimic the
    //       same behavior experienced prior to having the estimate notifier.
    if (isEstimateProgressNotificationCallback(callback)) {
      callback(1.0);
    } else {
      callback(0.0, 0.0);
    }
    return this;
  }

  then = this.handle.promise.then.bind(this.handle.promise);
  catch = this.handle.promise.catch.bind(this.handle.promise);
  finally = this.handle.promise.finally.bind(this.handle.promise);

  /** @internal */
  private emitProgress(transferredArg: binding.Int64, transferableArg: binding.Int64, progressEstimate: number) {
    const transferred = binding.Int64.intToNum(transferredArg);
    const transferable = binding.Int64.intToNum(transferableArg);
    for (const listener of this.listeners) {
      if (isEstimateProgressNotificationCallback(listener)) {
        listener(progressEstimate);
      } else {
        listener(transferred, transferable);
      }
    }
  }

  /** @internal */
  private createTimeoutPromise(config: Configuration, { timeOut, timeOutBehavior }: OpenBehavior) {
    if (typeof timeOut === "number") {
      this.timeoutPromise = new TimeoutPromise(
        this.handle.promise, // Ensures the timeout gets cancelled when the realm opens
        {
          ms: timeOut,
          message: `Realm could not be downloaded in the allocated time: ${timeOut} ms.`,
        },
      );
      if (timeOutBehavior === OpenRealmTimeOutBehavior.ThrowException) {
        // Make failing the timeout, reject the promise
        this.timeoutPromise.catch(this.handle.reject);
      } else if (timeOutBehavior === OpenRealmTimeOutBehavior.OpenLocalRealm) {
        // Make failing the timeout, resolve the promise
        this.timeoutPromise.catch((err) => {
          if (err instanceof TimeoutError) {
            this.cancelAndResetTask();
            const realm = new indirect.Realm(config);
            this.handle.resolve(realm);
          } else {
            this.handle.reject(err);
          }
        });
      } else {
        throw new Error(
          `Invalid 'timeOutBehavior': '${timeOutBehavior}'. Only 'throwException' and 'openLocalRealm' is allowed.`,
        );
      }
    }
  }

  /** @internal */
  private cancelAndResetTask() {
    if (this.task) {
      this.task.cancel();
      this.task.$resetSharedPtr();
      this.task = null;
    }
  }

  /** @internal */
  private rejectAsCanceled() {
    const err = new Error("Async open canceled");
    this.handle.reject(err);
  }

  get [Symbol.toStringTag]() {
    return ProgressRealmPromise.name;
  }
}
