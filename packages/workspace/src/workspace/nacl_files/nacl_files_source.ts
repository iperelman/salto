/*
*                      Copyright 2021 Salto Labs Ltd.
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
import _ from 'lodash'
import { logger } from '@salto-io/logging'
import {
  Element, ElemID, Value, DetailedChange, isElement, getChangeElement, isObjectType,
  isInstanceElement, isIndexPathPart, isReferenceExpression, isContainerType, TypeElement,
  getDeepInnerType, isVariable, Change,
} from '@salto-io/adapter-api'
import { resolvePath, TransformFuncArgs, transformElement } from '@salto-io/adapter-utils'
import { promises, values } from '@salto-io/lowerdash'
import { AdditionDiff } from '@salto-io/dag'
import { MergeError, mergeElements } from '../../merger'
import {
  getChangeLocations, updateNaclFileData, getChangesToUpdate, DetailedChangeWithSource,
  getNestedStaticFiles,
} from './nacl_file_update'
import { parse, SourceRange, ParseError, ParseResult, SourceMap } from '../../parser'
import { ElementsSource } from '../elements_source'
import { ParseResultCache, ParseResultKey } from '../cache'
import { DirectoryStore } from '../dir_store'
import { Errors } from '../errors'
import { StaticFilesSource } from '../static_files'
import { getStaticFilesFunctions } from '../static_files/functions'
import { buildNewMergedElementsAndErrors } from './elements_cache'

import { Functions } from '../../parser/functions'

const { withLimitedConcurrency } = promises.array

const log = logger(module)

export type RoutingMode = 'isolated' | 'default' | 'align' | 'override'

export const FILE_EXTENSION = '.nacl'
const PARSE_CONCURRENCY = 20
const DUMP_CONCURRENCY = 20
// TODO: this should moved into cache implemenation
const CACHE_READ_CONCURRENCY = 20

export type NaclFile = {
  buffer: string
  filename: string
  timestamp?: number
}

export type NaclFilesSource = Omit<ElementsSource, 'clear'> & {
  updateNaclFiles: (changes: DetailedChange[], mode?: RoutingMode) => Promise<Change[]>
  listNaclFiles: () => Promise<string[]>
  getTotalSize: () => Promise<number>
  getNaclFile: (filename: string) => Promise<NaclFile | undefined>
  getElementNaclFiles: (id: ElemID) => Promise<string[]>
  getElementReferencedFiles: (id: ElemID) => Promise<string[]>
  // TODO: this should be for single?
  setNaclFiles: (...naclFiles: NaclFile[]) => Promise<Change[]>
  removeNaclFiles: (...names: string[]) => Promise<Change[]>
  getSourceMap: (filename: string) => Promise<SourceMap>
  getSourceRanges: (elemID: ElemID) => Promise<SourceRange[]>
  getErrors: () => Promise<Errors>
  getParsedNaclFile: (filename: string) => Promise<ParsedNaclFile | undefined>
  clone: () => NaclFilesSource
  isEmpty: () => Promise<boolean>
  clear(args?: {
    nacl?: boolean
    staticResources?: boolean
    cache?: boolean
  }): Promise<void>
}

export type ParsedNaclFile = {
  filename: string
  elements: Element[]
  errors: ParseError[]
  timestamp: number
  referenced: ElemID[]
}

type ParsedNaclFileMap = {
  [key: string]: ParsedNaclFile
}

type NaclFilesState = {
  readonly parsedNaclFiles: ParsedNaclFileMap
  readonly elementsIndex: Record<string, string[]>
  readonly mergedElements: Record<string, Element>
  readonly mergeErrors: MergeError[]
  readonly referencedIndex: Record<string, string[]>
}

const cacheResultKey = (naclFile: { filename: string; timestamp?: number; buffer?: string }):
 ParseResultKey => ({
  filename: naclFile.filename,
  lastModified: naclFile.timestamp ?? Date.now(),
  buffer: naclFile.buffer,
})

const getTypeOrContainerTypeID = (typeElem: TypeElement): ElemID => (isContainerType(typeElem)
  ? getDeepInnerType(typeElem).elemID
  : typeElem.elemID)

const getElementReferenced = (element: Element): Set<string> => {
  const referenced = new Set<string>()
  const transformFunc = ({ value, field, path }: TransformFuncArgs): Value => {
    if (field && path && !isIndexPathPart(path.name)) {
      referenced.add(getTypeOrContainerTypeID(field.type).getFullName())
    }
    if (isReferenceExpression(value)) {
      const { parent, path: valueIDPath } = value.elemId.createTopLevelParentID()
      const nestedIds = valueIDPath.map((_p, index) => parent.createNestedID(
        ...(value.elemId.idType !== parent.idType ? [value.elemId.idType] : []),
        ...valueIDPath.slice(0, index + 1)
      ))
      referenced.add(parent.getFullName())
      nestedIds.forEach(id => referenced.add(id.getFullName()))
    }
    return value
  }

  if (isObjectType(element)) {
    Object.values(element.fields)
      .map(field => getTypeOrContainerTypeID(field.type))
      .forEach(id => referenced.add(id.getFullName()))
  }
  if (isInstanceElement(element)) {
    referenced.add(element.type.elemID.getFullName())
  }
  Object.values(element.annotationTypes)
    .map(anno => getTypeOrContainerTypeID(anno))
    .forEach(id => referenced.add(id.getFullName()))
  if (!isContainerType(element) && !isVariable(element)) {
    transformElement({ element, transformFunc, strict: false })
  }
  return referenced
}

const getElementsReferences = (elements: Element[]): ElemID[] => {
  const referenced = new Set<string>()
  elements.forEach(elem => {
    getElementReferenced(elem).forEach(r => referenced.add(r))
  })
  return [...referenced].map(r => ElemID.fromFullName(r))
}

export const toParsedNaclFile = (
  naclFile: NaclFile,
  parseResult: ParseResult
): ParsedNaclFile => ({
  timestamp: naclFile.timestamp || Date.now(),
  filename: naclFile.filename,
  elements: parseResult.elements,
  errors: parseResult.errors,
  referenced: getElementsReferences(parseResult.elements),
})

const parseNaclFile = async (
  naclFile: NaclFile, cache: ParseResultCache, functions: Functions
): Promise<Required<ParseResult>> => {
  const parseResult = await parse(Buffer.from(naclFile.buffer), naclFile.filename, functions)
  const key = cacheResultKey(naclFile)
  await cache.put(key, parseResult)
  return parseResult
}

const parseNaclFiles = async (
  naclFiles: NaclFile[], cache: ParseResultCache, functions: Functions
): Promise<ParsedNaclFile[]> =>
  withLimitedConcurrency(naclFiles.map(naclFile => async () => {
    const key = cacheResultKey(naclFile)
    const cachedResult = await cache.get(key)
    return cachedResult
      ? toParsedNaclFile(naclFile, cachedResult)
      : toParsedNaclFile(naclFile, await parseNaclFile(naclFile, cache, functions))
  }), PARSE_CONCURRENCY)

export const getFunctions = (staticFileSource: StaticFilesSource): Functions => ({
  ...getStaticFilesFunctions(staticFileSource), // add future functions here
})

export const getParsedNaclFiles = async (
  naclFilesStore: DirectoryStore<string>,
  cache: ParseResultCache,
  staticFileSource: StaticFilesSource
): Promise<ParsedNaclFile[]> => {
  const naclFiles = (await naclFilesStore.getFiles(await naclFilesStore.list()))
    .filter(values.isDefined)
  const functions = getFunctions(staticFileSource)
  return parseNaclFiles(naclFiles, cache, functions)
}

type buildNaclFilesStateResult = { state: NaclFilesState; changes: Change[] }
const buildNaclFilesState = (
  newNaclFiles: ParsedNaclFile[], currentState?: NaclFilesState
): buildNaclFilesStateResult => {
  const current = currentState ? currentState.parsedNaclFiles : {}
  log.debug('building elements indices for %d NaCl files', newNaclFiles.length)
  const newParsed = _.keyBy(newNaclFiles, parsed => parsed.filename)
  const allParsed = _.omitBy({ ...current, ...newParsed },
    parsed => (_.isEmpty(parsed.elements) && _.isEmpty(parsed.errors)))

  const elementsIndexSet: Record<string, Set<string>> = {}
  const referencedIndexSet: Record<string, Set<string>> = {}
  Object.values(allParsed).forEach(naclFile => {
    naclFile.elements.forEach(element => {
      const elementFullName = element.elemID.getFullName()
      elementsIndexSet[elementFullName] = elementsIndexSet[elementFullName] ?? new Set<string>()
      elementsIndexSet[elementFullName].add(naclFile.filename)
    })
    naclFile.referenced.forEach(elemID => {
      const elementFullName = elemID.getFullName()
      referencedIndexSet[elementFullName] = referencedIndexSet[elementFullName] ?? new Set<string>()
      referencedIndexSet[elementFullName].add(naclFile.filename)
    })
  })
  const elementsIndex = _.mapValues(elementsIndexSet, val => Array.from(val))
  const referencedIndex = _.mapValues(referencedIndexSet, val => Array.from(val))
  log.info('workspace has %d elements and %d parsed NaCl files',
    _.size(elementsIndex), _.size(allParsed))
  const newNaclFilesElements = newNaclFiles.flatMap(naclFile => naclFile.elements)

  if (_.isUndefined(currentState)) {
    const mergeResult = mergeElements(newNaclFilesElements)
    return {
      state: {
        parsedNaclFiles: allParsed,
        mergedElements: _.keyBy(mergeResult.merged, e => e.elemID.getFullName()),
        mergeErrors: mergeResult.errors,
        elementsIndex,
        referencedIndex,
      },
      changes: [],
    }
  }
  const currentElementsOfNewFiles = newNaclFiles
    .map(naclFile => naclFile.filename)
    .flatMap(filename => current?.[filename]?.elements ?? [])
  const relevantElementIDs = new Set(
    [...newNaclFilesElements, ...currentElementsOfNewFiles].map(e => e.elemID.getFullName())
  )

  const relevantFiles = _.uniq(
    [...relevantElementIDs].flatMap(fullName => elementsIndex[fullName] ?? [])
  )
  const newElementsToMerge = relevantFiles.flatMap(fileName => (
    allParsed[fileName].elements.filter(e => relevantElementIDs.has(e.elemID.getFullName()))
  ))
  const mergedResult = buildNewMergedElementsAndErrors({
    newElements: newElementsToMerge,
    relevantElementIDs: [...relevantElementIDs],
    currentElements: currentState.mergedElements,
    currentMergeErrors: currentState.mergeErrors,
  })
  return {
    state: {
      parsedNaclFiles: allParsed,
      mergedElements: mergedResult.mergedElements,
      mergeErrors: mergedResult.mergeErrors,
      elementsIndex,
      referencedIndex,
    },
    changes: mergedResult.changes,
  }
}

const logNaclFileUpdateErrorContext = (
  filename: string,
  fileChanges: DetailedChangeWithSource[],
  naclDataBefore: string,
  naclDataAfter: string,
): void => {
  log.debug('Parse errors in file %s after updating with changes:', filename)
  fileChanges.forEach(change => {
    log.debug(
      '%s of %s at location: (start=%o end=%o)',
      change.action,
      change.id.getFullName(),
      change.location.start,
      change.location.end,
    )
  })
  log.debug('data before:\n%s', naclDataBefore)
  log.debug('data after:\n%s', naclDataAfter)
}

const buildNaclFilesSource = (
  naclFilesStore: DirectoryStore<string>,
  cache: ParseResultCache,
  staticFileSource: StaticFilesSource,
  initState?: Promise<NaclFilesState>
): NaclFilesSource => {
  const functions: Functions = getFunctions(staticFileSource)

  const createNaclFileFromChange = async (
    filename: string,
    change: AdditionDiff<Element>,
    fileData: string,
  ): Promise<ParsedNaclFile> => {
    const elements = [(change as AdditionDiff<Element>).data.after]
    const referenced = getElementsReferences(elements)
    const parsed = {
      timestamp: Date.now(),
      filename,
      elements,
      errors: [],
      referenced,
    }
    const key = cacheResultKey({ filename: parsed.filename,
      buffer: fileData,
      timestamp: parsed.timestamp })
    await cache.put(key, { elements, errors: [] })
    return parsed
  }

  let state = initState
  const getState = (): Promise<NaclFilesState> => {
    if (_.isUndefined(state)) {
      state = getParsedNaclFiles(naclFilesStore, cache, staticFileSource)
        .then(parsedFiles => buildNaclFilesState(parsedFiles, undefined))
        .then(res => res.state)
    }
    return state
  }

  const buildNaclFilesStateInner = async (parsedNaclFiles: ParsedNaclFile[]):
  Promise<buildNaclFilesStateResult> => {
    if (_.isUndefined(state)) {
      return { changes: [], state: await getState() }
    }
    const current = await state
    return buildNaclFilesState(parsedNaclFiles, current)
  }

  const getNaclFile = (filename: string): Promise<NaclFile | undefined> =>
    naclFilesStore.get(filename)

  const getParsedNaclFile = async (filename: string): Promise<ParsedNaclFile | undefined> => {
    // We don't want to parse all nacl files here when we want only parsedResult of one file.
    if (state !== undefined) {
      return (await getState()).parsedNaclFiles[filename]
    }
    const naclFile = await getNaclFile(filename)
    if (naclFile === undefined) return undefined
    return (await parseNaclFiles([naclFile], cache, functions))[0]
  }

  const getElementNaclFiles = async (elemID: ElemID): Promise<string[]> => {
    const topLevelID = elemID.createTopLevelParentID()
    const topLevelFiles = (await getState()).elementsIndex[topLevelID.parent.getFullName()] || []
    return (await Promise.all(topLevelFiles.map(async filename => {
      const fragments = (await getParsedNaclFile(filename))?.elements ?? []
      return fragments.some(fragment => resolvePath(fragment, elemID) !== undefined)
        ? filename
        : undefined
    }))).filter(values.isDefined)
  }

  const getElementReferencedFiles = async (elemID: ElemID): Promise<string[]> => {
    const ref = (await getState()).referencedIndex
    return ref[elemID.getFullName()] || []
  }

  const getSourceMap = async (filename: string): Promise<SourceMap> => {
    const parsedNaclFile = (await getState()).parsedNaclFiles[filename]
    const key = cacheResultKey(parsedNaclFile)
    const cachedResult = await cache.get(key)
    if (cachedResult && cachedResult.sourceMap) {
      return cachedResult.sourceMap
    }
    const naclFile = (await naclFilesStore.get(filename))
    if (_.isUndefined(naclFile)) {
      log.error('failed to find %s in NaCl file store', filename)
      return new SourceMap()
    }
    const parsedResult = await parseNaclFile(naclFile, cache, functions)
    return parsedResult.sourceMap
  }

  const setNaclFiles = async (
    ...naclFiles: NaclFile[]
  ): Promise<void> => {
    const [emptyNaclFiles, nonEmptyNaclFiles] = _.partition(
      naclFiles,
      naclFile => _.isEmpty(naclFile.buffer.trim())
    )
    await Promise.all(nonEmptyNaclFiles.map(naclFile => naclFilesStore.set(naclFile)))
    await Promise.all(emptyNaclFiles.map(naclFile => naclFilesStore.delete(naclFile.filename)))
  }

  const updateNaclFiles = async (changes: DetailedChange[]): Promise<Change[]> => {
    const getNaclFileData = async (filename: string): Promise<string> => {
      const naclFile = await naclFilesStore.get(filename)
      return naclFile ? naclFile.buffer : ''
    }

    // This method was written with the assumption that each static file is pointed by no more
    // then one value inthe nacls. A ticket was open to fix that (SALTO-954)

    const removeDanglingStaticFiles = async (fileChanges: DetailedChange[]): Promise<void> => {
      await Promise.all(fileChanges.filter(change => change.action === 'remove')
        .map(getChangeElement)
        .map(getNestedStaticFiles)
        .flatMap(files => files.map(file => staticFileSource.delete(file))))
    }

    const naclFiles = _(await Promise.all(changes.map(change => change.id)
      .map(elemID => getElementNaclFiles(elemID.createTopLevelParentID().parent))))
      .flatten().uniq().value()
    const { parsedNaclFiles } = await getState()
    const changedFileToSourceMap: Record<string, SourceMap> = _.fromPairs(
      await withLimitedConcurrency(naclFiles
        .map(naclFile => async () => [parsedNaclFiles[naclFile].filename,
          await getSourceMap(parsedNaclFiles[naclFile].filename)]),
      CACHE_READ_CONCURRENCY)
    )
    const mergedSourceMap = Object.values(changedFileToSourceMap).reduce((acc, sourceMap) => {
      acc.merge(sourceMap)
      return acc
    }, new SourceMap())

    const changesToUpdate = getChangesToUpdate(changes, mergedSourceMap)
    const updatedNaclFiles = (await withLimitedConcurrency(
      _(changesToUpdate)
        .map(change => getChangeLocations(change, mergedSourceMap))
        .flatten()
        // Group changes file, we use lower case in order to support case insensitive file systems
        .groupBy(change => change.location.filename.toLowerCase())
        .entries()
        .map(([_lowerCaseFilename, fileChanges]) => async ():
          Promise<ParsedNaclFile & NaclFile | undefined> => {
          // Changes might have a different cased filename, we just take the first variation
          const [filename] = fileChanges.map(change => change.location.filename).sort()
          try {
            const naclFileData = await getNaclFileData(filename)
            const buffer = await updateNaclFileData(naclFileData, fileChanges, functions)
            const shouldNotParse = _.isEmpty(naclFileData)
              && fileChanges.length === 1
              && fileChanges[0].action === 'add'
              && isElement(fileChanges[0].data.after)
            const parsed = shouldNotParse
              ? await createNaclFileFromChange(filename, fileChanges[0] as AdditionDiff<Element>,
                buffer)
              : toParsedNaclFile({ filename, buffer },
                await parseNaclFile({ filename, buffer }, cache, functions))
            if (parsed.errors.length > 0) {
              logNaclFileUpdateErrorContext(filename, fileChanges, naclFileData, buffer)
            }
            await removeDanglingStaticFiles(fileChanges)
            return { ...parsed, buffer }
          } catch (e) {
            log.error('failed to update NaCl file %s with %o changes due to: %o',
              filename, fileChanges, e)
            return undefined
          }
        })
        .value(),
      DUMP_CONCURRENCY
    )).filter(values.isDefined)

    if (updatedNaclFiles.length > 0) {
      log.debug('going to update %d NaCl files', updatedNaclFiles.length)
      // The map is to avoid saving unnecessary fields in the nacl files
      await setNaclFiles(
        ...updatedNaclFiles.map(file => _.pick(file, ['buffer', 'filename', 'timestamp']))
      )
      // The map is to avoid saving unnecessary fields in the state
      const res = await buildNaclFilesStateInner(
        updatedNaclFiles.map(file => _.pick(file, ['filename', 'elements', 'errors', 'timestamp', 'referenced']))
      )
      state = Promise.resolve(res.state)
      return res.changes
    }
    return []
  }

  return {
    list: async (): Promise<ElemID[]> =>
      Object.keys((await getState()).elementsIndex).map(name => ElemID.fromFullName(name)),

    get: async (id: ElemID): Promise<Element | Value> => {
      const currentState = await getState()
      const { parent, path } = id.createTopLevelParentID()
      const baseElement = currentState.mergedElements[parent.getFullName()]
      return baseElement && !_.isEmpty(path) ? resolvePath(baseElement, id) : baseElement
    },

    getAll: async (): Promise<Element[]> => _.values((await getState()).mergedElements),

    flush: async (): Promise<void> => {
      await naclFilesStore.flush()
      await cache.flush()
      await staticFileSource.flush()
    },

    getErrors: async (): Promise<Errors> => {
      const currentState = await getState()
      return new Errors({
        parse: _.flatten(Object.values(currentState.parsedNaclFiles).map(parsed => parsed.errors)),
        merge: currentState.mergeErrors,
        validation: [],
      })
    },

    listNaclFiles: async (): Promise<string[]> => Object.keys((await getState()).parsedNaclFiles),

    getTotalSize: async (): Promise<number> =>
      _.sum(await Promise.all([naclFilesStore.getTotalSize(), staticFileSource.getTotalSize()])),

    getNaclFile,

    getParsedNaclFile,

    getSourceRanges: async elemID => {
      const naclFiles = await getElementNaclFiles(elemID)
      const sourceRanges = await withLimitedConcurrency(naclFiles
        .map(naclFile => async () => (await getSourceMap(naclFile))
          .get(elemID.getFullName()) || []),
      CACHE_READ_CONCURRENCY)
      return _.flatten(sourceRanges)
    },

    removeNaclFiles: async (...names: string[]) => {
      await Promise.all(names.map(name => naclFilesStore.delete(name)))
      const res = await buildNaclFilesStateInner(
        await parseNaclFiles(names.map(filename => ({ filename, buffer: '' })), cache, functions),
      )
      state = Promise.resolve(res.state)
      return res.changes
    },

    clear: async (args = { nacl: true, staticResources: true, cache: true }) => {
      if (args.staticResources && !(args.cache && args.nacl)) {
        throw new Error('Cannot clear static resources without clearing the cache and nacls')
      }

      // The order is important
      if (args.staticResources) {
        await staticFileSource.clear()
      }
      if (args.nacl) {
        await naclFilesStore.clear()
      }
      if (args.cache) {
        await cache.clear()
      }
      state = undefined
    },

    rename: async (name: string) => {
      await naclFilesStore.rename(name)
      await staticFileSource.rename(name)
      await cache.rename(name)
    },

    clone: () => buildNaclFilesSource(
      naclFilesStore.clone(),
      cache.clone(),
      staticFileSource.clone(),
      state,
    ),
    updateNaclFiles,
    setNaclFiles: async (...naclFiles) => {
      await setNaclFiles(...naclFiles)
      const res = await buildNaclFilesStateInner(await parseNaclFiles(naclFiles, cache, functions))
      state = Promise.resolve(res.state)
      return res.changes
    },
    getSourceMap,
    getElementNaclFiles,
    getElementReferencedFiles,
    isEmpty: () => naclFilesStore.isEmpty(),
  }
}

export const naclFilesSource = (
  naclFilesStore: DirectoryStore<string>,
  cache: ParseResultCache,
  staticFileSource: StaticFilesSource,
  parsedFiles?: ParsedNaclFile[],
): NaclFilesSource => {
  const state = (parsedFiles !== undefined)
    ? buildNaclFilesState(parsedFiles, undefined).state
    : undefined
  return buildNaclFilesSource(
    naclFilesStore,
    cache,
    staticFileSource,
    state !== undefined ? Promise.resolve(state) : undefined,
  )
}
