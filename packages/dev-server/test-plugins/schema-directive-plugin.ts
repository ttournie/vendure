import { Directive, Query, Resolver } from '@nestjs/graphql';
import { VendurePlugin } from '@vendure/core';
import { ApolloServer, gql, SchemaDirectiveVisitor } from 'apollo-server-express';
import { defaultFieldResolver, GraphQLField } from 'graphql';

const typeDefs = gql`
    directive @upper on FIELD_DEFINITION

    extend type Query {
        hello: String @upper
    }
`;

@Resolver()
export class HelloResolver {
    @Query()
    hello() {
        return 'hello';
    }
}

/**
 * Based on the example given here: https://docs.nestjs.com/graphql/directives
 *
 * But does not seem to work, for some unknown reason. The `hello` query does not
 * get uppercased, and a breakpoint in the `visitFieldDefinition()` method will
 * not get hit.
 */
class UpperCaseDirective extends SchemaDirectiveVisitor {
    // Called on server startup for each @uppercase field
    visitFieldDefinition(field: GraphQLField<any, any>) {
        // Obtain the field's resolver
        const { resolve = defaultFieldResolver } = field;

        // *Replace* the field's resolver with a function
        // that calls the *original* resolver, then converts
        // the result to uppercase before returning
        field.resolve = async function (...args: any[]) {
            const result = await resolve.apply(this, args as any);
            if (typeof result === 'string') {
                return result.toUpperCase();
            }
            return result;
        };
    }
}

@VendurePlugin({
    shopApiExtensions: {
        schema: typeDefs,
        resolvers: [HelloResolver],
        schemaDirectives: {
            upper: UpperCaseDirective,
        },
    },
    adminApiExtensions: {
        schema: typeDefs,
        resolvers: [HelloResolver],
        schemaDirectives: {
            upper: UpperCaseDirective,
        },
    },
})
export class SchemaDirectivePlugin {}
