'use strict';

const os = require('os');

const hashLRU = require('hashlru');
const graphQL = require('graphql');

const modelError = require('./error');
const introspectFields = require('./introspectFields');

function resolveSchema(_config) {
  const mashup = {
    schemas: [_config.schema],
    populates: [],
    extensions: []
  };

  if (_config.populate) mashup.populates.push(_config.populate);

  if (_config.dependencies) {
    for (const dependency of _config.dependencies) {
      const dependencyMashup = resolveSchema(dependency);
      mashup.schemas.push(...dependencyMashup.schemas);
      mashup.populates.push(...dependencyMashup.populates);
      mashup.extensions.push(...dependencyMashup.extensions);
    }
  }

  if (_config.extensions) mashup.extensions.push(..._config.extensions);

  return mashup;
}

function extendSchema(_parent, _config) {
  const mashup = resolveSchema(_config);
  const extensionSchema = mashup.schemas.join(os.EOL);
  const astExtension = graphQL.parse(extensionSchema);
  let schema = _parent ?
    graphQL.extendSchema(_parent, astExtension) :
    graphQL.buildASTSchema(astExtension);

  for (const populate of mashup.populates) {
    populate(schema, graphQL);
  }

  for (const extension of mashup.extensions) {
    schema = extendSchema(schema, extension);
  }

  return schema;
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
    dependencies: [],
    cacheSize: 100,
    ..._config
  };

  const schema = extendSchema(null, config);
  const errors = graphQL.validateSchema(schema);
  if (errors.length) {
    throw new modelError('Invalid GraphQL schema', errors);
  }

  const cache = hashLRU(config.cacheSize);
  async function request(_context, _query, _variables, _operationName) {
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

    return await graphQL.execute(
      schema,
      astQuery,
      config.root,
      _context,
      _variables,
      _operationName
    );
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
