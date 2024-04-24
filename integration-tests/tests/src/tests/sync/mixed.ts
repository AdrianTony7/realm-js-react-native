////////////////////////////////////////////////////////////////////////////
//
// Copyright 2020 Realm Inc.
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
import { expect } from "chai";
import Realm, { BSON, Configuration, ConfigurationWithSync, Mixed, ObjectSchema, SyncConfiguration } from "realm";

import { importAppBefore, authenticateUserBefore, openRealmBefore } from "../../hooks";
import { itUploadsDeletesAndDownloads } from "./upload-delete-download";
import { buildAppConfig } from "../../utils/build-app-config";
import { OpenRealmConfiguration } from "../../utils/open-realm";
import { sleep } from "../../utils/sleep";
import { generateRandomPathAndNonce } from "../../utils/generators";

type Value = Realm.Mixed | ((realm: Realm) => Realm.Mixed);
type ValueTester = (actual: Realm.Mixed, inserted: Realm.Mixed, realm?: Realm) => void;

class MixedClass extends Realm.Object<MixedClass> {
  _id!: BSON.ObjectId;
  value: Realm.Mixed;
  list!: Realm.List<Realm.Mixed>;
  dict!: Realm.Dictionary<Realm.Mixed>;

  static schema: ObjectSchema = {
    name: "MixedClass",
    properties: {
      _id: "objectId",
      value: "mixed",
      list: "mixed[]",
      dict: "mixed{}",
    },
    primaryKey: "_id",
  };
}

/**
 * The default tester of values.
 * @param actual The value downloaded from the server.
 * @param inserted The value inserted locally before upload.
 */
function defaultTester(actual: Realm.Mixed, inserted: Realm.Mixed, realm?: Realm) {
  if (actual instanceof Realm.List) {
    const insertedVal = inserted as Realm.Mixed[];
    actual.forEach((item, index) => defaultTester(item, insertedVal[index], realm));
  } else if (actual instanceof Realm.Dictionary) {
    const insertedVal = inserted as { [key: string]: any };
    Object.keys(actual).forEach((key) => defaultTester(actual[key], insertedVal[key], realm));
  } else if (actual instanceof BSON.Decimal128) {
    const insertedVal = inserted as BSON.Decimal128;
    expect(actual.bytes.equals(insertedVal.bytes)).equals(true);
  } else if (actual instanceof BSON.ObjectID) {
    const insertedVal = inserted as BSON.ObjectID;
    expect(actual.equals(insertedVal)).equals(true);
  } else if (actual instanceof BSON.UUID) {
    const insertedVal = inserted as BSON.UUID;
    expect(actual.equals(insertedVal)).equals(true);
  } else if (actual instanceof Date) {
    const insertedVal = inserted as Date;
    expect(actual.getTime() == insertedVal.getTime()).equals(true);
  } else if (actual instanceof ArrayBuffer) {
    const actualBinaryView = new Uint8Array(actual);
    const insertedBinaryView = new Uint8Array(inserted as ArrayBuffer);
    expect(actualBinaryView.byteLength).equals(insertedBinaryView.byteLength);
    actualBinaryView.forEach((item, index) => defaultTester(item, insertedBinaryView[index]));
  } else if (actual instanceof MixedClass && realm) {
    const insertedVal = realm.objects(MixedClass).filtered("_id = $0", actual._id)[0];
    expect(actual._id.equals(insertedVal._id)).equals(true);
    defaultTester(actual.value, insertedVal.value);
  } else {
    expect(actual).equals(inserted);
  }
}

async function setupTest(realm: Realm, useFlexibleSync: boolean) {
  if (useFlexibleSync) {
    await realm.subscriptions.update((mutableSubs) => {
      mutableSubs.add(realm.objects(MixedClass));
    });
    await realm.subscriptions.waitForSynchronization();
  }
}

/**
 * Registers a test suite that:
 * - Opens a synced Realm
 * - Performs an object creation
 * - Uploads the local Realm
 * - Deletes the Realm locally
 * - Reopens and downloads the Realm
 * - Performs a test to ensure the downloaded value match the value created locally.
 * @param typeName Name of the mixed type (only used for the test name)
 * @param value The value to be used for the test, or a function to obtain it
 * @param testValue The function used to assert equality
 * @param useFlexibleSync Boolean to indicate the use of flexible sync (otherwise partition based sync will be used)
 */
function describeRoundtrip({
  typeName,
  value,
  valueTester = defaultTester,
  useFlexibleSync,
}: {
  typeName: string;
  value: Value;
  valueTester?: ValueTester;
  useFlexibleSync: boolean;
}) {
  function performTest(actual: Realm.Mixed, inserted: Realm.Mixed, realm: Realm) {
    valueTester(actual, inserted, realm);
  }

  describe(`roundtrip of '${typeName}'`, () => {
    openRealmBefore({
      schema: [MixedClass],
      sync: useFlexibleSync ? { flexible: true } : { partitionValue: "mixed-test" },
    });

    it("writes", async function (this: RealmContext) {
      await setupTest(this.realm, useFlexibleSync);
      //TODO Maybe I could also check that the dictionary can change value
      this._id = new BSON.ObjectId();
      this.realm.write(() => {
        this.value = typeof value === "function" ? value(this.realm) : value;
        this.realm.create(MixedClass, {
          _id: this._id,
          value: this.value,
          // Adding a few other unrelated elements to the list
          list: [this.value, 123, false, "something-else"],
        });
      });
    });

    itUploadsDeletesAndDownloads();

    it("reads", async function (this: RealmContext) {
      await setupTest(this.realm, useFlexibleSync);

      const obj = await new Promise<MixedClass>((resolve) => {
        this.realm
          .objects(MixedClass) //TODO Remember to do it in other places
          .filtered("_id = $0", this._id)
          .addListener(([obj]) => {
            if (obj) {
              resolve(obj);
            }
          });
      });

      expect(typeof obj).equals("object");
      // Test the single value
      performTest(obj.value, this.value, this.realm);
      // Test the list of values
      expect(obj.list.length).equals(4);
      const firstElement = obj.list[0];
      performTest(firstElement, this.value, this.realm);
      // No need to keep these around
      delete this._id;
      delete this.value;
    });
  });
}

function describeTypes(useFlexibleSync: boolean) {
  authenticateUserBefore();

  describeRoundtrip({ typeName: "null", value: null, useFlexibleSync });

  // TODO: Provide an API to specify storing this as an int
  describeRoundtrip({ typeName: "int", value: 123, useFlexibleSync });

  // TODO: Provide an API to specify which of these to store
  describeRoundtrip({ typeName: "float / double", value: 123.456, useFlexibleSync });
  describeRoundtrip({ typeName: "bool (true)", value: true, useFlexibleSync });
  describeRoundtrip({ typeName: "bool (false)", value: false, useFlexibleSync });
  describeRoundtrip({ typeName: "string", value: "test-string", useFlexibleSync });

  const buffer = new Uint8Array([4, 8, 12, 16]).buffer;
  describeRoundtrip({
    typeName: "data",
    value: buffer,
    useFlexibleSync: useFlexibleSync,
  });

  const date = new Date(1620768552979);
  describeRoundtrip({
    typeName: "date",
    value: date,
    useFlexibleSync: useFlexibleSync,
  });

  const objectId = new BSON.ObjectId("609afc1290a3c1818f04635e");
  describeRoundtrip({
    typeName: "ObjectId",
    value: objectId,
    useFlexibleSync: useFlexibleSync,
  });

  const uuid = new BSON.UUID("9476a497-60ef-4439-bc8a-52b8ad0d4875");
  describeRoundtrip({
    typeName: "UUID",
    value: uuid,
    useFlexibleSync: useFlexibleSync,
  });

  const decimal128 = BSON.Decimal128.fromString("1234.5678");
  describeRoundtrip({
    typeName: "Decimal128",
    value: decimal128,
    useFlexibleSync: useFlexibleSync,
  });

  const recursiveObjectId = new BSON.ObjectId();
  describeRoundtrip({
    typeName: "object link",
    value: (realm: Realm) => {
      // Create an object
      const result = realm.create<MixedClass>("MixedClass", {
        _id: recursiveObjectId,
        value: null,
      });
      // Make it recursive
      result.value = result;
      return result;
    },
    valueTester: (value: MixedClass) => {
      expect(recursiveObjectId.equals(value._id)).equals(true); //TODO I should be able to put this into the default tester
    },
    useFlexibleSync: useFlexibleSync,
  });

  if (useFlexibleSync) {
    describe("Collections in mixed", () => {
      describeRoundtrip({
        typeName: "list",
        value: getMixedList,
        useFlexibleSync: true,
      });

      describeRoundtrip({
        typeName: "nested list",
        value: getNestedMixedList,
        useFlexibleSync: true,
      });

      describeRoundtrip({
        typeName: "dictionary",
        value: getMixedDict,
        useFlexibleSync: true,
      });

      describeRoundtrip({
        typeName: "nested dictionary",
        value: getNestedMixedDict,
        useFlexibleSync: true,
      });
    });
  }
}

const bool = true;
const int = 1;
const double = 123.456;
const d128 = BSON.Decimal128.fromString("6.022e23");
const string = "hello";
const date = new Date();
const oid = new BSON.ObjectId();
const uuid = new BSON.UUID();
const nullValue = null;
const data = new Uint8Array([0xd8, 0x21, 0xd6, 0xe8, 0x00, 0x57, 0xbc, 0xb2, 0x6a, 0x15]).buffer;

function getMixedList(realm: Realm) {
  const obj = realm.write(() => {
    return realm.create(MixedClass, { _id: new BSON.ObjectId() });
  });

  return [bool, int, double, d128, string, oid, uuid, nullValue, date, data, obj];
}

function getMixedDict(realm: Realm) {
  const obj = realm.write(() => {
    return realm.create(MixedClass, { _id: new BSON.ObjectId() });
  });

  return {
    bool,
    int,
    double,
    d128,
    string,
    oid,
    uuid,
    nullValue,
    date,
    data,
    obj,
  };
}

function getNestedMixedList(realm: Realm) {
  return [...getMixedList(realm), getMixedList(realm), getMixedDict(realm)];
}

function getNestedMixedDict(realm: Realm) {
  return {
    ...getMixedDict(realm),
    innerList: getMixedList(realm),
    innerDict: getMixedDict(realm),
  };
}

describe.only("mixed synced", () => {
  //TODO Reenable these
  // describe("partition-based sync roundtrip", function () {
  //   this.longTimeout();
  //   importAppBefore(buildAppConfig("with-pbs").anonAuth().partitionBasedSync());
  //   describeTypes(false);
  // });

  // describe.skipIf(environment.skipFlexibleSync, "flexible sync roundtrip", function () {
  //   this.longTimeout();
  //   importAppBefore(buildAppConfig("with-flx").anonAuth().flexibleSync());
  //   describeTypes(true);
  // });

  describe.skipIf(environment.skipFlexibleSync, "mixed collections", function () {
    this.retries(3);

    type MultiRealmContext = {
      realm1: Realm;
      realm2: Realm;
      config1: Configuration;
      config2: Configuration;
    } & AppContext &
      Mocha.Context;

    this.longTimeout();
    importAppBefore(buildAppConfig("with-flx").anonAuth().flexibleSync());

    beforeEach(async function (this: MultiRealmContext) {
      const config = {
        schema: [MixedClass],
        path: generateRandomPathAndNonce().path,
      };
      const { realm1, realm2 } = await logInAndGetRealms(this.app, config);
      this.realm1 = realm1;
      this.realm2 = realm2;
      this.config1 = { ...config, sync: realm1.syncSession?.config };
      this.config2 = { ...config, sync: realm2.syncSession?.config };
    });

    afterEach(async function (this: MultiRealmContext) {
      deleteAllObjects(this.realm1, this.realm2);
      await sleep(1000);
      closeAndDeleteRealms(this.config1, this.config2);

      // Tests seem to become less flaky if waiting.
      // await sleep(1000);
    });

    function closeAndDeleteRealms(...configs: Configuration[]) {
      for (const config of configs) {
        Realm.deleteFile(config);
      }
      Realm.clearTestState();
    }

    function deleteAllObjects(...realms: Realm[]) {
      for (const realm of realms) {
        realm.write(() => {
          realm.deleteAll();
        });
      }
    }

    async function logInAndGetRealm(app: Realm.App, config: Configuration) {
      const user = await app.logIn(Realm.Credentials.anonymous(false));

      const syncConfig: SyncConfiguration = config.sync ? { ...config.sync, user } : { flexible: true, user };
      const configWithUser: ConfigurationWithSync = { ...config, sync: syncConfig };

      const realm = await Realm.open(configWithUser);
      await realm.subscriptions.update((mutableSubs) => {
        mutableSubs.add(realm.objects(MixedClass));
      });
      await realm.subscriptions.waitForSynchronization();

      return realm;
    }

    async function logInAndGetRealms(app: Realm.App, config: Configuration) {
      const realm1 = await logInAndGetRealm(app, config);
      const realm2 = await logInAndGetRealm(app, config);
      expect(realm1.objects(MixedClass).length).equals(0);
      expect(realm2.objects(MixedClass).length).equals(0);

      return { realm1, realm2 };
    }

    async function waitForSynchronization({
      uploadRealm,
      downloadRealm,
    }: {
      uploadRealm: Realm;
      downloadRealm: Realm;
    }) {
      if (!uploadRealm.syncSession) {
        throw new Error("No syncSession found on 'uploadRealm'");
      }
      if (!downloadRealm.syncSession) {
        throw new Error("No syncSession found on 'downloadRealm'");
      }

      await uploadRealm.syncSession.uploadAllLocalChanges();
      await downloadRealm.syncSession.downloadAllServerChanges();
    }

    function expectRealmObject(object: unknown): asserts object is Realm.Object {
      expect(object).instanceOf(Realm.Object);
    }

    function expectRealmList(value: unknown): asserts value is Realm.List<unknown> {
      expect(value).instanceOf(Realm.List);
    }

    function expectRealmDictionary(value: unknown): asserts value is Realm.Dictionary<unknown> {
      expect(value).instanceOf(Realm.Dictionary);
    }

    describe("Various types", () => {
      it("can update top-level property", async function (this: MultiRealmContext) {
        const id = new BSON.ObjectId();
        const obj1 = this.realm1.write(() => this.realm1.create(MixedClass, { _id: id }));

        const valuesToInsert = getNestedMixedList(this.realm1);
        for (const value of valuesToInsert) {
          this.realm1.write(() => {
            obj1.value = value;
          });

          await waitForSynchronization({ uploadRealm: this.realm1, downloadRealm: this.realm2 });

          const obj2 = this.realm2.objectForPrimaryKey(MixedClass, id);
          expectRealmObject(obj2);

          defaultTester(obj2.value, value, this.realm2);
        }
      });
    });

    describe("List", () => {
      it("can add item", async function (this: MultiRealmContext) {
        const id = new BSON.ObjectId();
        const { value: list1 } = this.realm1.write(() => {
          return this.realm1.create(MixedClass, {
            _id: id,
            value: [],
          });
        });
        expectRealmList(list1);

        // We will keep this list updated with the values we expect to find.
        const expectedList = [];

        // Adding elements one by one and verifying that the list is synchronized.
        const valuesToInsert = getNestedMixedList(this.realm1);
        for (const value of valuesToInsert) {
          this.realm1.write(() => {
            list1.push(value);
          });
          expectedList.push(value);

          await waitForSynchronization({ uploadRealm: this.realm1, downloadRealm: this.realm2 });

          const obj2 = this.realm2.objectForPrimaryKey(MixedClass, id);
          expectRealmObject(obj2);

          defaultTester(obj2.value, expectedList, this.realm2);
        }
      });

      it("can remove item", async function (this: MultiRealmContext) {
        const id = new BSON.ObjectId();
        const valuesToInsert = getNestedMixedList(this.realm1);
        const { value: list1 } = this.realm1.write(() => {
          return this.realm1.create(MixedClass, { _id: id, value: valuesToInsert });
        });
        expectRealmList(list1);

        await waitForSynchronization({ uploadRealm: this.realm1, downloadRealm: this.realm2 });

        const obj2 = this.realm2.objectForPrimaryKey(MixedClass, id);
        expectRealmObject(obj2);
        const list2 = obj2.value;
        expectRealmList(list2);
        defaultTester(list2, valuesToInsert, this.realm2);

        // We will keep this list updated with the values we expect to find.
        const expectedList = [...valuesToInsert];

        // Removing elements one by one and verifying that the list is synchronized.
        for (let i = 0; i < valuesToInsert.length; i++) {
          this.realm1.write(() => {
            list1.pop();
          });
          expectedList.pop();

          await waitForSynchronization({ uploadRealm: this.realm1, downloadRealm: this.realm2 });

          defaultTester(obj2.value, expectedList, this.realm2);
        }

        expect(list1.length).equals(0);
        expect(list2.length).equals(0);
      });

      it("can update item", async function (this: Mocha.Context & AppContext & MultiRealmContext) {
        const id = new BSON.ObjectId();
        const { value: list1 } = this.realm1.write(() => {
          return this.realm1.create(MixedClass, { _id: id, value: ["test"] });
        });
        expectRealmList(list1);

        await waitForSynchronization({ uploadRealm: this.realm1, downloadRealm: this.realm2 });

        const obj2 = this.realm2.objectForPrimaryKey(MixedClass, id);
        expectRealmObject(obj2);
        const list2 = obj2.value;
        expectRealmList(list2);

        // We will keep this list updated with the values we expect to find.
        const expectedList: Mixed[] = ["test"];

        // Changing the first element and verifying that the list is synchronized.
        const valuesToInsert = getNestedMixedList(this.realm1);
        for (const val of valuesToInsert) {
          this.realm1.write(() => {
            list1[0] = val;
          });
          expectedList[0] = val;

          await waitForSynchronization({ uploadRealm: this.realm1, downloadRealm: this.realm2 });

          defaultTester(list2, expectedList, this.realm2);
        }
      });
    });
  });
});
