/*
*                      Copyright 2020 Salto Labs Ltd.
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with
* the License.  You may obtain a copy of the License at
*
*     http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/
import { ATTRIBUTES, INTERNAL_ID, SCRIPT_ID } from '../src/constants'

export const recordInList = {
  [ATTRIBUTES]: {
    internalId: '19',
    'xsi:type': 'setupCustom:EntityCustomField',
  },
  label: 'My Entity Custom Field Name',
  owner: {
    [ATTRIBUTES]: {
      internalId: '-5',
    },
    name: 'Owner Name',
  },
  storeValue: true,
  showInList: false,
  globalSearch: false,
  isParent: false,
  subtab: {
    [ATTRIBUTES]: {
      internalId: '-4',
    },
    name: 'Main',
  },
  displayType: '_hidden',
  isMandatory: false,
  checkSpelling: false,
  defaultChecked: false,
  isFormula: false,
  appliesToCustomer: true,
  appliesToVendor: false,
  appliesToEmployee: false,
  appliesToOtherName: false,
  appliesToContact: true,
  appliesToPartner: false,
  appliesToWebSite: false,
  appliesToGroup: false,
  availableExternally: false,
  accessLevel: '_edit',
  appliesToStatement: false,
  searchLevel: '_edit',
  appliesToPriceList: false,
  fieldType: '_freeFormText',
  scriptId: 'custentity_myScriptId',
}

export const returnedReferenceMock = {
  [ATTRIBUTES]: {
    [SCRIPT_ID]: 'custentity_my_script_id',
    [INTERNAL_ID]: '123',
    type: 'entityCustomField',
    'xsi:type': 'platformCore:CustomizationRef',
  },
}