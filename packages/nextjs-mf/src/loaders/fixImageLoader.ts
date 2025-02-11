import type { LoaderContext } from 'webpack';
import { Template } from 'webpack';
import path from 'path';

/**
 * This loader is specifically created for tuning the next-image-loader result.
 * It modifies the regular string output of the next-image-loader.
 * For server-side rendering (SSR), it injects the remote scope of a specific remote URL.
 * For client-side rendering (CSR), it injects the document.currentScript.src.
 * After these injections, it selects the full URI before _next.
 *
 * @example
 * http://localhost:1234/test/test2/_next/static/media/ssl.e3019f0e.svg
 * will become
 * http://localhost:1234/test/test2
 *
 * @param {LoaderContext<Record<string, unknown>>} this - The loader context.
 * @param {string} remaining - The remaining part of the resource path.
 * @returns {string} The modified source code with the injected code.
 */
export async function fixImageLoader(
  this: LoaderContext<Record<string, unknown>>,
  remaining: string,
) {
  this.cacheable(true);

  const isServer = this._compiler?.options.name !== 'client';
  //@ts-ignore
  const { publicPath } = this._compiler?.webpack.RuntimeGlobals;

  const result = await this.importModule(
    `${this.resourcePath}.webpack[javascript/auto]!=!${remaining}`,
  );

  const content = (result.default || result) as Record<string, string>;

  const computedAssetPrefix = isServer
    ? `${Template.asString([
        'function getSSRImagePath(){',
        Template.asString([
          'try {',
          Template.indent([
            'const config = globalThis.__remote_scope__ &&',
            'globalThis.__remote_scope__._config;',
            `const remoteEntry = config[__webpack_runtime_id__] || ${publicPath}`,
            `if (remoteEntry) {`,
            Template.indent([
              `const splitted = remoteEntry.split('/_next')`,
              `return splitted.length === 2 ? splitted[0] : '';`,
            ]),
            `}`,
            `return '';`,
          ]),
          '} catch (e) {',
          Template.indent([
            `console.error('failed generating SSR image path', e);`,
            'return "";',
          ]),
          '}',
        ]),
        '}()',
      ])}`
    : `${Template.asString([
        'function getCSRImagePath(){',
        Template.indent([
          'try {',
          Template.indent([
            `if(typeof document === 'undefined')`,
            Template.indent(
              `return ${publicPath} && ${publicPath}.indexOf('://') > 0 ? new URL(${publicPath}).origin : ''`,
            ),
            `const path = (document.currentScript && document.currentScript.src) || new URL(${publicPath}).origin;`,
            `const splitted = path.split('/_next')`,
            `return splitted.length === 2 ? splitted[0] : '';`,
          ]),
          '} catch (e) {',
          Template.indent([
            `const path = document.currentScript && document.currentScript.src;`,
            `console.error('failed generating CSR image path', e, path);`,
            'return "";',
          ]),
          '}',
        ]),
        '}()',
      ])}`;

  const constructedObject = Object.entries(content).reduce(
    (acc, [key, value]) => {
      if (key === 'src') {
        if (value && !value.includes('://')) {
          value = path.join(value);
        }
        acc.push(
          `${key}: computedAssetsPrefixReference + ${JSON.stringify(value)}`,
        );
        return acc;
      }
      acc.push(`${key}: ${JSON.stringify(value)}`);
      return acc;
    },
    [] as string[],
  );

  return Template.asString([
    "let computedAssetsPrefixReference = '';",
    'try {',
    Template.indent(`computedAssetsPrefixReference = ${computedAssetPrefix};`),
    '} catch (e) {}',
    'export default {',
    Template.indent(constructedObject.join(',\n')),
    '}',
  ]);
}

/**
 * The pitch function of the loader, which is the same as the fixImageLoader function.
 */
export const pitch = fixImageLoader;
