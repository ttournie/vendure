import { DynamicModule } from '@nestjs/common';
import { GqlModuleOptions, GraphQLModule, GraphQLTypesLoader } from '@nestjs/graphql';
import { notNullOrUndefined } from '@vendure/common/lib/shared-utils';
import { buildSchema, extendSchema, GraphQLSchema, printSchema, ValidationContext } from 'graphql';
import path from 'path';

import { ConfigModule } from '../../config/config.module';
import { ConfigService } from '../../config/config.service';
import { I18nModule } from '../../i18n/i18n.module';
import { I18nService } from '../../i18n/i18n.service';
import { getDynamicGraphQlModulesForPlugins } from '../../plugin/dynamic-plugin-api.module';
import {
    getPluginAPIExtensions,
    isDynamicModule,
    PLUGIN_METADATA,
    reflectMetadata,
} from '../../plugin/plugin-metadata';
import { APIExtensionDefinition } from '../../plugin/vendure-plugin';
import { ServiceModule } from '../../service/service.module';
import { ApiSharedModule } from '../api-internal-modules';
import { CustomFieldRelationResolverService } from '../common/custom-field-relation-resolver.service';
import { IdCodecService } from '../common/id-codec.service';
import { AssetInterceptorPlugin } from '../middleware/asset-interceptor-plugin';
import { IdCodecPlugin } from '../middleware/id-codec-plugin';
import { TranslateErrorsPlugin } from '../middleware/translate-errors-plugin';

import { generateAuthenticationTypes } from './generate-auth-types';
import { generateErrorCodeEnum } from './generate-error-code-enum';
import { generateListOptions } from './generate-list-options';
import { generatePermissionEnum } from './generate-permissions';
import { generateResolvers } from './generate-resolvers';
import {
    addActiveAdministratorCustomFields,
    addGraphQLCustomFields,
    addModifyOrderCustomFields,
    addOrderLineCustomFieldsInput,
    addRegisterCustomerCustomFieldsInput,
    addServerConfigCustomFields,
} from './graphql-custom-fields';

export interface GraphQLApiOptions {
    apiType: 'shop' | 'admin';
    typePaths: string[];
    apiPath: string;
    debug: boolean;
    playground: boolean | any;
    // tslint:disable-next-line:ban-types
    resolverModule: Function;
    validationRules: Array<(context: ValidationContext) => any>;
}

/**
 * Dynamically generates a GraphQLModule according to the given config options.
 */
export function configureGraphQLModule(
    getOptions: (configService: ConfigService) => GraphQLApiOptions,
): DynamicModule {
    return GraphQLModule.forRootAsync({
        useFactory: (
            configService: ConfigService,
            i18nService: I18nService,
            idCodecService: IdCodecService,
            typesLoader: GraphQLTypesLoader,
            customFieldRelationResolverService: CustomFieldRelationResolverService,
        ) => {
            return createGraphQLOptions(
                i18nService,
                configService,
                idCodecService,
                typesLoader,
                customFieldRelationResolverService,
                getOptions(configService),
            );
        },
        inject: [
            ConfigService,
            I18nService,
            IdCodecService,
            GraphQLTypesLoader,
            CustomFieldRelationResolverService,
        ],
        imports: [ConfigModule, I18nModule, ApiSharedModule, ServiceModule],
    });
}

async function createGraphQLOptions(
    i18nService: I18nService,
    configService: ConfigService,
    idCodecService: IdCodecService,
    typesLoader: GraphQLTypesLoader,
    customFieldRelationResolverService: CustomFieldRelationResolverService,
    options: GraphQLApiOptions,
): Promise<GqlModuleOptions> {
    const builtSchema = await buildSchemaForApi(options.apiType);
    const resolvers = generateResolvers(
        configService,
        customFieldRelationResolverService,
        options.apiType,
        builtSchema,
    );
    const schemaDirectives = getSchemaDirectives(options.apiType);
    return {
        path: '/' + options.apiPath,
        typeDefs: printSchema(builtSchema),
        include: [options.resolverModule, ...getDynamicGraphQlModulesForPlugins(options.apiType)],
        fieldResolverEnhancers: ['guards'],
        resolvers,
        schemaDirectives,
        // We no longer rely on the upload facility bundled with Apollo Server, and instead
        // manually configure the graphql-upload package. See https://github.com/vendure-ecommerce/vendure/issues/396
        uploads: false,
        playground: options.playground || false,
        debug: options.debug || false,
        context: (req: any) => req,
        // This is handled by the Express cors plugin
        cors: false,
        plugins: [
            new IdCodecPlugin(idCodecService),
            new TranslateErrorsPlugin(i18nService),
            new AssetInterceptorPlugin(configService),
            ...configService.apiOptions.apolloServerPlugins,
        ],
        validationRules: options.validationRules,
    } as GqlModuleOptions;

    /**
     * Generates the server's GraphQL schema by combining:
     * 1. the default schema as defined in the source .graphql files specified by `typePaths`
     * 2. any custom fields defined in the config
     * 3. any schema extensions defined by plugins
     */
    async function buildSchemaForApi(apiType: 'shop' | 'admin'): Promise<GraphQLSchema> {
        const customFields = configService.customFields;
        // Paths must be normalized to use forward-slash separators.
        // See https://github.com/nestjs/graphql/issues/336
        const normalizedPaths = options.typePaths.map(p => p.split(path.sep).join('/'));
        const typeDefs = await typesLoader.mergeTypesByPaths(normalizedPaths);
        const authStrategies =
            apiType === 'shop'
                ? configService.authOptions.shopAuthenticationStrategy
                : configService.authOptions.adminAuthenticationStrategy;
        let schema = buildSchema(typeDefs);

        getPluginAPIExtensions(configService.plugins, apiType)
            .map(e => (typeof e.schema === 'function' ? e.schema() : e.schema))
            .filter(notNullOrUndefined)
            .forEach(documentNode => (schema = extendSchema(schema, documentNode)));
        schema = generateListOptions(schema);
        schema = addGraphQLCustomFields(schema, customFields, apiType === 'shop');
        schema = addOrderLineCustomFieldsInput(schema, customFields.OrderLine || []);
        schema = addModifyOrderCustomFields(schema, customFields.Order || []);
        schema = generateAuthenticationTypes(schema, authStrategies);
        schema = generateErrorCodeEnum(schema);
        if (apiType === 'admin') {
            schema = addServerConfigCustomFields(schema, customFields);
            schema = addActiveAdministratorCustomFields(schema, customFields.Administrator);
        }
        if (apiType === 'shop') {
            schema = addRegisterCustomerCustomFieldsInput(schema, customFields.Customer || []);
        }
        schema = generatePermissionEnum(schema, configService.authOptions.customPermissions);

        return schema;
    }

    function getSchemaDirectives(apiType: 'shop' | 'admin'): Record<string, any> {
        const schemaDirectivesMap = new Map<string, { pluginName: string; directive: any }>();

        for (const plugin of configService.plugins) {
            const apiExtensions: APIExtensionDefinition | undefined =
                apiType === 'shop'
                    ? reflectMetadata(plugin, PLUGIN_METADATA.SHOP_API_EXTENSIONS)
                    : reflectMetadata(plugin, PLUGIN_METADATA.ADMIN_API_EXTENSIONS);
            if (apiExtensions?.schemaDirectives) {
                const directivesForPlugin: Record<string, any> =
                    typeof apiExtensions.schemaDirectives === 'function'
                        ? apiExtensions.schemaDirectives()
                        : apiExtensions.schemaDirectives;
                const pluginName = isDynamicModule(plugin) ? plugin.module.name : plugin.name;
                for (const [name, directive] of Object.entries(directivesForPlugin)) {
                    const conflicting = schemaDirectivesMap.get(name);
                    if (conflicting) {
                        throw new Error(
                            `Conflicting schemaDirective "${name}", defined in ${conflicting.pluginName} and ${pluginName}`,
                        );
                    }
                    schemaDirectivesMap.set(name, { pluginName, directive });
                }
            }
        }
        return Array.from(schemaDirectivesMap.entries()).reduce((directives, [name, { directive }]) => {
            return {
                ...directives,
                [name]: directive,
            };
        }, {} as Record<string, any>);
    }
}
