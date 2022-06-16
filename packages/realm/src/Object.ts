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

import { Results } from "./Results";

/**
 * PropertyType
 * @see { @link https://realm.io/docs/javascript/latest/api/Realm.html#~PropertyType }
 */
export type PropertyType =
  | string
  | "bool"
  | "int"
  | "float"
  | "double"
  | "decimal128"
  | "objectId"
  | "string"
  | "data"
  | "date"
  | "list"
  | "linkingObjects";

/**
 * The canonical representation of the schema of a specific class.
 */
export type CanonicalObjectSchema<T = { [name: string]: unknown }> = {
  name: string;
  properties: Record<keyof T, CanonicalObjectSchemaProperty>;
  primaryKey?: string;
  embedded?: boolean;
  asymmetric?: boolean;
};

/**
 * The canonical representation of the schema of a specific property.
 */
export type CanonicalObjectSchemaProperty = {
  name: string;
  type: PropertyType;
  optional: boolean;
  indexed: boolean;
  mapTo: string;
  objectType?: string;
  property?: string;
};

export class Object<T = Record<string, unknown>> {
  /**
   * FIXME: Use keyof in this methods return signature type signature
   */
  keys(): string[] {
    throw new Error("Not yet implemented");
  }
  /**
   * FIXME: Use keyof in this methods return signature type signature
   */
  entries(): [string, unknown][] {
    throw new Error("Not yet implemented");
  }
  toJSON(): unknown {
    throw new Error("Not yet implemented");
  }
  isValid(): boolean {
    throw new Error("Not yet implemented");
  }
  objectSchema(): CanonicalObjectSchema<T> {
    throw new Error("Not yet implemented");
  }
  linkingObjects<T>(): Results<T> {
    throw new Error("Not yet implemented");
  }
  linkingObjectsCount(): number {
    throw new Error("Not yet implemented");
  }
  _objectId(): string {
    throw new Error("Not yet implemented");
  }
  addListener(): void {
    throw new Error("Not yet implemented");
  }
  removeListener(): void {
    throw new Error("Not yet implemented");
  }
  removeAllListeners(): void {
    throw new Error("Not yet implemented");
  }
  getPropertyType(): string {
    throw new Error("Not yet implemented");
  }
}
