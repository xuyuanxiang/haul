import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { inspect } from 'util';
import webpack from 'webpack';
import terser, { MinifyOptions } from 'terser';
import Worker from 'jest-worker';

import IndexRamBundle from './IndexRamBundle';
import FileRamBundle from './FileRamBundle';

export type Module = {
  id: string | number;
  idx: number;
  filename: string;
  source: string;
  map: Object;
};

type Compilation = webpack.compilation.Compilation & {
  moduleTemplate: any;
  options: webpack.Configuration;
  mainTemplate: webpack.compilation.MainTemplate & {
    renderBootstrap: Function;
    hooks: webpack.compilation.CompilationHooks & {
      renderWithEntry: { call: Function };
    };
  };
  moduleTemplates: {
    javascript: webpack.compilation.ModuleTemplate & {
      render: Function;
    };
  };
};

type ModuleMappings = {
  modules: { [key: string]: number };
  chunks: { [key: string]: Array<number | string> };
};

type RamBundleWebpackPluginOptions = {
  singleBundleMode?: boolean;
  sourceMap?: boolean;
  indexRamBundle?: boolean;
  preloadBundles?: string[];
  minify?: boolean;
  minifyOptions?: Pick<
    MinifyOptions,
    Exclude<keyof MinifyOptions, 'sourceMap'>
  >;
  maxWorkers: number;
  bundleId: number | string;
  bundleName: string;
};

const variableToString = (value?: string | number) => {
  if (value === undefined) {
    return 'undefined';
  }
  return typeof value === 'string' ? `"${value}"` : value.toString();
};

const hasValue = (value: any): boolean =>
  typeof value === 'undefined' ? false : true;

export default class RamBundleWebpackPlugin {
  name = 'RamBundleWebpackPlugin';

  modules: Module[] = [];
  sourceMap: boolean = false;
  indexRamBundle: boolean = true;
  preloadBundles: string[];
  bundleId: number | string = 'index';
  bundleName: string = 'index';
  singleBundleMode: boolean = true;
  minify: boolean = false;
  minifyOptions: RamBundleWebpackPluginOptions['minifyOptions'] = undefined;
  maxWorkers: number;

  constructor({
    sourceMap,
    indexRamBundle,
    preloadBundles,
    singleBundleMode,
    minify,
    minifyOptions,
    maxWorkers,
    bundleId,
    bundleName,
  }: RamBundleWebpackPluginOptions) {
    this.sourceMap = Boolean(sourceMap);
    this.indexRamBundle = Boolean(indexRamBundle);
    this.preloadBundles = preloadBundles || [];
    this.singleBundleMode = hasValue(singleBundleMode)
      ? Boolean(singleBundleMode)
      : this.singleBundleMode;
    this.minify = hasValue(minify) ? Boolean(minify) : this.minify;
    this.minifyOptions = minifyOptions;
    this.maxWorkers = maxWorkers;
    this.bundleId = bundleId;
    this.bundleName = bundleName;
  }

  apply(compiler: webpack.Compiler) {
    compiler.hooks.emit.tapPromise(
      'RamBundleWebpackPlugin',
      async _compilation => {
        // Cast compilation from @types/webpack to custom Compilation type
        // which contains additional properties.
        const compilation: Compilation = _compilation as any;

        const moduleMappings: ModuleMappings = {
          modules: {},
          chunks: {},
        };

        let mainId: string | number | undefined;
        let mainChunk: webpack.compilation.Chunk | undefined;

        (compilation.chunks as webpack.compilation.Chunk[]).forEach(chunk => {
          if ((chunk.id as any) === 'main' || chunk.name === 'main') {
            mainChunk = chunk;
            mainId = chunk.entryModule?.id ?? undefined;
          }

          chunk.getModules().forEach(moduleInChunk => {
            if (chunk.id !== null) {
              moduleMappings.chunks[chunk.id] = ([] as Array<string | number>)
                .concat(...(moduleMappings.chunks[chunk.id] || []))
                .concat(moduleInChunk.id ?? []);
            }
          });
        });

        // Omit chunks mapping if there's only a single main chunk
        if (compilation.chunks.length === 1) {
          moduleMappings.chunks = {};
        }

        if (mainId === undefined) {
          throw new Error(
            "RamBundleWebpackPlugin: couldn't find main chunk's entry module id"
          );
        }
        if (!mainChunk) {
          throw new Error("RamBundleWebpackPlugin: couldn't find main chunk");
        }
        // Render modules to it's 'final' form with injected webpack variables
        // and wrapped with ModuleTemplate.
        const minifyWorker = new Worker(
          require.resolve(
            '../../../../build/webpack/plugins/RamBundleWebpackPlugin/worker'
          ),
          {
            numWorkers: this.maxWorkers,
            enableWorkerThreads: true,
          }
        );

        this.modules = await Promise.all(
          compilation.modules.map(async webpackModule => {
            const renderedModule = compilation.moduleTemplates.javascript
              .render(
                webpackModule,
                compilation.dependencyTemplates,
                compilation.options
              )
              .sourceAndMap();

            if (typeof webpackModule.id === 'string') {
              moduleMappings.modules[webpackModule.id] = webpackModule.index;
            }

            let code = `__haul_${this.bundleName}.l(${variableToString(
              webpackModule.id
            )}, ${renderedModule.source});`;
            let map = renderedModule.map;

            if (this.minify) {
              const minifyOptionsWithMap = {
                ...this.minifyOptions,
                sourceMap: {
                  content: map,
                },
              };
              // @ts-ignore property minify does not exist on type 'JestWorker'
              const minifiedSource = await minifyWorker.minify(
                code,
                minifyOptionsWithMap
              );
              //Check if there is no error in minifed source
              assert(!minifiedSource.error, minifiedSource.error);

              code = minifiedSource.code || '';
              if (typeof minifiedSource.map === 'string') {
                map = JSON.parse(minifiedSource.map);
              }
            }

            return {
              id: webpackModule.id,
              idx: webpackModule.index,
              filename: webpackModule.resource,
              source: code,
              map: {
                ...map,
                file: `${
                  typeof webpackModule.id === 'string'
                    ? webpackModule.index
                    : webpackModule.id
                }.js`,
              },
            };
          })
        );

        minifyWorker.end();

        const indent = (line: string) => `/*****/  ${line}`;
        let bootstrap = fs.readFileSync(
          path.join(
            __dirname,
            '../../../../runtime/webpack/plugin/ram-bundle-webpack-plugin/bootstrap.js'
          ),
          'utf8'
        );
        if (typeof this.bundleName !== 'string' || !this.bundleName.length) {
          throw new Error(
            'RamBundleWebpackPlugin: bundle name cannot be empty string'
          );
        }

        bootstrap =
          `(${bootstrap.trim()})(this, ${inspect(
            {
              bundleName: this.bundleName,
              bundleId: this.bundleId,
              mainModuleId: mainId,
              preloadBundleNames: this.preloadBundles,
              singleBundleMode: this.singleBundleMode,
              moduleMappings,
            },
            {
              depth: null,
              maxArrayLength: null,
              breakLength: Infinity,
            }
          )});`
            .split('\n')
            .map(indent)
            .join('\n') + '\n';

        // Enhance bootstrapCode with additional JS from plugins that hook
        // into `renderWithEntry` for example: webpack's `library` is used here to expose
        // bundle as a library.
        const renderWithEntryResults = compilation.mainTemplate.hooks.renderWithEntry.call(
          bootstrap,
          mainChunk,
          mainChunk.hash
        );
        if (typeof renderWithEntryResults === 'string') {
          bootstrap = renderWithEntryResults;
        } else if ('source' in renderWithEntryResults) {
          bootstrap = renderWithEntryResults.source();
        }

        if (this.minify) {
          const { error, code } = terser.minify(bootstrap);
          if (error) {
            throw error;
          }
          bootstrap = code || '';
        }

        const outputFilename = compilation.outputOptions.filename!;
        const outputDest = path.isAbsolute(outputFilename)
          ? outputFilename
          : path.join(compilation.outputOptions.path, outputFilename);

        const sourceMapFilename = compilation.getPath(
          compilation.outputOptions.sourceMapFilename,
          {
            filename: path.isAbsolute(outputFilename)
              ? path.relative(compilation.context, outputFilename)
              : outputFilename,
          }
        );

        const bundle = this.indexRamBundle
          ? new IndexRamBundle(bootstrap, this.modules, this.sourceMap)
          : new FileRamBundle(
              bootstrap,
              this.modules,
              this.sourceMap,
              this.bundleName,
              this.singleBundleMode
            );

        const filesToRemove: string[] = compilation.chunks.reduce(
          (acc, chunk) => {
            if (chunk.name !== 'main') {
              return [...acc, ...chunk.files];
            }
            return acc;
          },
          []
        );
        Object.keys(compilation.assets).forEach(assetName => {
          const remove = filesToRemove.some(file => assetName.endsWith(file));
          if (remove) {
            delete compilation.assets[assetName];
          }
        });

        bundle.build({
          outputDest,
          outputFilename,
          sourceMapFilename,
          compilation,
        });
      }
    );
  }
}
