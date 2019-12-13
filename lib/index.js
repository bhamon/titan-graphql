'use strict';

const os = require('os');

const hashLRU = require('hashlru');
const graphQL = require('graphql');

const modelError = require('./error');
const introspectFields = require('./introspectFields');

function collectExtensions(_extensions) {
  const mashup = {
    schemas: [],
    populates: []
  };

  for (const extension of _extensions) {
    mashup.schemas.push(extension.schema);
    if (extension.populate) {
      mashup.populates.push(extension.populate);
    }

    if (extension.extensions) {
      const childMashup = collectExtensions(extension.extensions);
      mashup.schemas.push(...childMashup.schemas);
      mashup.populates.push(...childMashup.populates);
    }
  }

  return mashup;
}

function factory(_config) {
  const proto = {};
  const config = {
    schema: `
      type Query
      type Mutation

      schema {
        query: Query
        mutation: Mutation
      }
    `,
    root: {},
    extensions: [],
    cacheSize: 100,
    ..._config
  };

  const astSchema = graphQL.parse(config.schema);
  let schema = graphQL.buildASTSchema(astSchema);
  if (config.extensions.length) {
    const mashup = collectExtensions(config.extensions);
    const extensionsSchema = mashup.schemas.join(os.EOL);
    const astExtensions = graphQL.parse(extensionsSchema);
    schema = graphQL.extendSchema(schema, astExtensions);

    for (const populate of mashup.populates) {
      populate(schema, graphQL);
    }
  }

  const errors = graphQL.validateSchema(schema);
  if (errors.length) {
    throw new modelError('Invalid GraphQL schema', errors);
  }

  const cache = hashLRU(config.cacheSize);
  function request(_context, _query, _variables, _operationName) {
    if (typeof _query !== 'string') {
      throw new modelError('Missing GraphQL query');
    }

    let astQuery = cache.get(_query);
    if (!astQuery) {
      try {
        astQuery = graphQL.parse(_query);
      } catch (ex) {
        throw new modelError(ex.message);
      }

      const errors = graphQL.validate(schema, astQuery);
      if (errors.length) {
        throw new modelError('Invalid GraphQL query', errors);
      }

      cache.set(_query, astQuery);
    }

    try {
      return graphQL.execute(
        schema,
        astQuery,
        config.root,
        _context,
        _variables,
        _operationName
      );
    } catch (ex) {
      throw new modelError(ex.message);
    }
  }

  Object.defineProperties(proto, {
    request: {enumerable: true, value: request}
  });

  return proto;
}

Object.defineProperties(factory, {
  GraphQLError: {enumerable: true, value: modelError},
  introspectFields: {enumerable: true, value: introspectFields}
});

module.exports = factory;
