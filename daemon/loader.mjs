// Node module-resolution shim, installed by register.mjs.
//
// Why this exists: @strudel/core@1.2.6 imports `@kabelsalat/web`, and the package
// as published has no `SalatRepl` export at its entry point, so importing
// @strudel/core throws.  The real code is fine -- it lives at dist/index.mjs --
// so this redirects the bare specifier there.  Measured on 2026-09-25; without
// this, `import '@strudel/core'` fails outright.
export async function resolve(specifier, context, next) {
  if (specifier === '@kabelsalat/web') {
    return next('@kabelsalat/web/dist/index.mjs', context);
  }
  return next(specifier, context);
}
