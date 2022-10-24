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

import { binding } from "../internal";

/**
 * Types of an authentication provider.
 */
export enum ProviderType {
  AnonUser = "anon-user",
  ApiKey = "api-key",
  LocalUserPass = "local-userpass",
  CustomFunction = "custom-function",
  CustomToken = "custom-token",
  OAuth2Google = "oauth2-google",
  OAuth2Facebook = "oauth2-facebook",
  OAuth2Apple = "oauth2-apple",
}

export function isProviderType(arg: string): arg is ProviderType {
  return Object.values(ProviderType).includes(arg as ProviderType);
}

export class Credentials {
  /** @internal */
  public internal: binding.AppCredentials;

  /** @internal */
  private constructor(internal: binding.AppCredentials) {
    this.internal = internal;
  }

  static anonymous(reuse = true): Credentials {
    return new Credentials(binding.AppCredentials.anonymous(reuse));
  }
}
