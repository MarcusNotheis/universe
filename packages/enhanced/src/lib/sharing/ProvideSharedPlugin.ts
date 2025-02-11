/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra and Zackary Jackson @ScriptedAlchemy
*/

'use strict';

import { parseOptions } from '../container/options';
import createSchemaValidation from 'webpack/lib/util/create-schema-validation';
import WebpackError from 'webpack/lib/WebpackError';
import ProvideForSharedDependency from './ProvideForSharedDependency';
import ProvideSharedDependency from './ProvideSharedDependency';
import ProvideSharedModuleFactory from './ProvideSharedModuleFactory';
import type Compiler from 'webpack/lib/Compiler';
import type Compilation from 'webpack/lib/Compilation';
import type { ProvideSharedPluginOptions } from '../../declarations/plugins/sharing/ProvideSharedPlugin';

export type ProvideOptions = {
  shareKey: string;
  shareScope: string;
  version: string | undefined | false;
  eager: boolean;
};
export type ResolvedProvideMap = Map<
  string,
  {
    config: ProvideOptions;
    version: string | undefined | false;
  }
>;

const validate = createSchemaValidation(
  //eslint-disable-next-line
  require('webpack/schemas/plugins/sharing/ProvideSharedPlugin.check.js'),
  () => require('webpack/schemas/plugins/sharing/ProvideSharedPlugin.json'),
  {
    name: 'Provide Shared Plugin',
    baseDataPath: 'options',
  },
);

/**
 * @typedef {Object} ProvideOptions
 * @property {string} shareKey
 * @property {string} shareScope
 * @property {string | undefined | false} version
 * @property {boolean} eager
 */

/** @typedef {Map<string, { config: ProvideOptions, version: string | undefined | false }>} ResolvedProvideMap */

class ProvideSharedPlugin {
  private _provides: [string, ProvideOptions][];

  /**
   * @param {ProvideSharedPluginOptions} options options
   */
  constructor(options: ProvideSharedPluginOptions) {
    validate(options);
    //@ts-ignore
    this._provides = parseOptions(
      options.provides,
      (item) => {
        if (Array.isArray(item))
          throw new Error('Unexpected array of provides');
        /** @type {ProvideOptions} */
        const result = {
          shareKey: item,
          version: undefined,
          shareScope: options.shareScope || 'default',
          eager: false,
        };
        return result;
      },
      (item) => ({
        shareKey: item.shareKey,
        version: item.version,
        shareScope: item.shareScope || options.shareScope || 'default',
        eager: !!item.eager,
      }),
    );
    this._provides.sort(([a], [b]) => {
      if (a < b) return -1;
      if (b < a) return 1;
      return 0;
    });
  }

  /**
   * Apply the plugin
   * @param {Compiler} compiler the compiler instance
   * @returns {void}
   */
  apply(compiler: Compiler): void {
    const compilationData: WeakMap<Compilation, ResolvedProvideMap> =
      new WeakMap();

    compiler.hooks.compilation.tap(
      'ProvideSharedPlugin',
      (compilation: Compilation, { normalModuleFactory }) => {
        const resolvedProvideMap: ResolvedProvideMap = new Map();
        const matchProvides: Map<string, ProvideOptions> = new Map();
        const prefixMatchProvides: Map<string, ProvideOptions> = new Map();
        for (const [request, config] of this._provides) {
          if (/^(\/|[A-Za-z]:\\|\\\\|\.\.?(\/|$))/.test(request)) {
            // relative request
            resolvedProvideMap.set(request, {
              config,
              version: config.version,
            });
          } else if (/^(\/|[A-Za-z]:\\|\\\\)/.test(request)) {
            // absolute path
            resolvedProvideMap.set(request, {
              config,
              version: config.version,
            });
          } else if (request.endsWith('/')) {
            // module request prefix
            prefixMatchProvides.set(request, config);
          } else {
            // module request
            matchProvides.set(request, config);
          }
        }
        compilationData.set(compilation, resolvedProvideMap);
        const provideSharedModule = (
          key: string,
          config: ProvideOptions,
          resource: string,
          resourceResolveData: any,
        ) => {
          let version = config.version;
          if (version === undefined) {
            let details = '';
            if (!resourceResolveData) {
              details = `No resolve data provided from resolver.`;
            } else {
              const descriptionFileData =
                resourceResolveData.descriptionFileData;
              if (!descriptionFileData) {
                details =
                  'No description file (usually package.json) found. Add description file with name and version, or manually specify version in shared config.';
              } else if (!descriptionFileData.version) {
                details = `No version in description file (usually package.json). Add version to description file ${resourceResolveData.descriptionFilePath}, or manually specify version in shared config.`;
              } else {
                version = descriptionFileData.version;
              }
            }
            if (!version) {
              const error = new WebpackError(
                `No version specified and unable to automatically determine one. ${details}`,
              );
              error.file = `shared module ${key} -> ${resource}`;
              compilation.warnings.push(error);
            }
          }
          resolvedProvideMap.set(resource, {
            config,
            version,
          });
        };
        normalModuleFactory.hooks.module.tap(
          'ProvideSharedPlugin',
          (module, { resource, resourceResolveData }, resolveData) => {
            if (resource && resolvedProvideMap.has(resource)) {
              return module;
            }
            const { request } = resolveData;
            {
              const config = matchProvides.get(request);
              if (config !== undefined && resource) {
                provideSharedModule(
                  request,
                  config,
                  resource,
                  resourceResolveData,
                );
                resolveData.cacheable = false;
              }
            }
            for (const [prefix, config] of prefixMatchProvides) {
              if (request.startsWith(prefix) && resource) {
                const remainder = request.slice(prefix.length);
                provideSharedModule(
                  resource,
                  {
                    ...config,
                    shareKey: config.shareKey + remainder,
                  },
                  resource,
                  resourceResolveData,
                );
                resolveData.cacheable = false;
              }
            }
            return module;
          },
        );
      },
    );
    compiler.hooks.finishMake.tapPromise(
      'ProvideSharedPlugin',
      async (compilation: Compilation) => {
        const resolvedProvideMap = compilationData.get(compilation);
        if (!resolvedProvideMap) return;
        await Promise.all(
          Array.from(
            resolvedProvideMap,
            ([resource, { config, version }]) =>
              new Promise<void>((resolve, reject) => {
                compilation.addInclude(
                  compiler.context,
                  //@ts-ignore
                  new ProvideSharedDependency(
                    config.shareScope,
                    config.shareKey,
                    version || false,
                    resource,
                    config.eager,
                  ),
                  {
                    name: undefined,
                  },
                  (err: WebpackError | null | undefined) => {
                    if (err) return reject(err);
                    resolve();
                  },
                );
              }),
          ),
        );
      },
    );

    compiler.hooks.compilation.tap(
      'ProvideSharedPlugin',
      (compilation: Compilation, { normalModuleFactory }) => {
        compilation.dependencyFactories.set(
          ProvideForSharedDependency,
          normalModuleFactory,
        );

        compilation.dependencyFactories.set(
          //@ts-ignore
          ProvideSharedDependency,
          new ProvideSharedModuleFactory(),
        );
      },
    );
  }
}
export default ProvideSharedPlugin;
