#!/usr/bin/env node
import * as fs from 'fs';
import { spawnSync } from 'child_process';

if (process.argv.length < 3) {
    console.log('Usage: amplify-data-resource-count <api_name>');
    process.exit(1);
}

const API_NAME = process.argv[2];
const LOCAL_STACKS_PATH = `amplify/backend/api/${API_NAME}/build/stacks`;
const CLOUD_STACKS_PATH = `amplify/#current-cloud-backend/api/${API_NAME}/build/stacks`;

export const getStacks = (STACKS_PATH: string) => {
    const stacks = fs.readdirSync(STACKS_PATH);
    const result = {};
    let RESOLVERS_COUNT = 0;
    let FUNCTIONS_COUNT = 0;
    let RESOURCES_COUNT = 0;
    let REFERENCES_COUNT = 0;
    const RESOLVERS_RESOURCES: any = {};
    const FUNCTIONS_RESOURCES: any = {};
    const REFERENCES_MAP = {};
    for (const stack of stacks) {
        result[stack] = fs.readFileSync(`${STACKS_PATH}/${stack}`, 'utf8');
        RESOLVERS_COUNT += (result[stack].match(/AWS::AppSync::Resolver/g) || []).length;
        FUNCTIONS_COUNT += (result[stack].match(/AWS::AppSync::FunctionConfiguration/g) || []).length;
        RESOURCES_COUNT += JSON.parse(result[stack]).Resources ? Object.keys(JSON.parse(result[stack]).Resources).length : 0;

        const resources = JSON.parse(result[stack]).Resources;
        for (const key of Object.keys(resources)) {
            if (resources[key].Type === 'AWS::AppSync::Resolver') {
                RESOLVERS_RESOURCES[key] = resources[key];
                const references = resources[key].Properties.PipelineConfig.Functions.filter((f: any) => f.Ref);
                for (const ref of references) {
                    if (!REFERENCES_MAP[ref.Ref]) {
                        REFERENCES_MAP[ref.Ref] = 0;
                        REFERENCES_COUNT ++;
                    }
                    REFERENCES_MAP[ref.Ref]++;
                }
            }
            if (resources[key].Type === 'AWS::AppSync::FunctionConfiguration') {
                FUNCTIONS_RESOURCES[key] = resources[key];
            }
        }
    }

    const REUSE_REFERENCES = Object.keys(REFERENCES_MAP).reduce((acc: any, key) => {
        if (isNaN(acc)) {
            acc = 0;
        }
        if (REFERENCES_MAP[key] > 0) {
            acc += REFERENCES_MAP[key];
        }
        return acc;
    }, 0);

    const UNSAFE_TO_DELETE_FUNCTIONS: string[] = [];
    for (const key of Object.keys(FUNCTIONS_RESOURCES)) {
        const functionName = FUNCTIONS_RESOURCES[key].Properties.Name;
        if (Object.keys(REFERENCES_MAP).find((ref) => ref.includes(functionName))) {
            UNSAFE_TO_DELETE_FUNCTIONS.push(functionName);
        }
    }
    
    return {
        RESOLVERS_COUNT,
        FUNCTIONS_COUNT,
        RESOURCES_COUNT,
        TOTAL_STACKS: stacks.length,
        RESOLVERS_RESOURCES,
        FUNCTIONS_RESOURCES,
        REFERENCES_COUNT,
        REUSE_REFERENCES,
        UNSAFE_TO_DELETE_FUNCTIONS,
    };
};

const displayCounts = (summary: any) => {
    console.log('\x1b[34m\tTOTAL RESOURCES :', summary.RESOURCES_COUNT);
    console.log('\x1b[34m\t# OF RESOLVERS  :', summary.RESOLVERS_COUNT);
    console.log('\x1b[34m\t# OF FUNCTIONS  :', summary.FUNCTIONS_COUNT);
    console.log('\x1b[34m\t# OF STACKS     :', summary.TOTAL_STACKS);
    console.log('\x1b[34m\t# OF REFERENCES :', summary.REFERENCES_COUNT, 'Functions reused', summary.REUSE_REFERENCES, 'times');
};


const runAmplifyCompile = () => {
    console.log('Running amplify api gql-compile ...');
    spawnSync('amplify', ['api', 'gql-compile']);
    console.log('Schema compilation completed.');
};

const compareStacks = () => {
    console.log('----------------------------------------------------------------------------------------');
    console.log('Comparing stacks ...');
    console.log('----------------------------------------------------------------------------------------');
    console.log('Current cloud state: ');
    const beforeCompilation = getStacks(CLOUD_STACKS_PATH);
    displayCounts(beforeCompilation);

    console.log('----------------------------------------------------------------------------------------');
    console.log('Deleting any of the below AppSync functions will trigger more resource updates than expected:');
    console.log('----------------------------------------------------------------------------------------');
    console.log(beforeCompilation.UNSAFE_TO_DELETE_FUNCTIONS.map((f: string) => `\x1b[31m${f}`).join('\n'), '\x1b[0m');

    console.log('****************************************************************************************');
    runAmplifyCompile();
    console.log('****************************************************************************************');

    console.log('New State: ');
    const afterCompilation = getStacks(LOCAL_STACKS_PATH);
    displayCounts(afterCompilation);
    console.log('----------------------------------------------------------------------------------------');

    const resolversDiff = compareResolvers(beforeCompilation, afterCompilation);
    const functionsDiff = compareFunctions(beforeCompilation, afterCompilation);
    console.log('\x1b[32mRESOLVERS/FUNCTIONS TO BE CREATED/UPDATED/DELETED: ', resolversDiff + functionsDiff);
    console.log('----------------------------------------------------------------------------------------');
    console.log();
    console.log('** The above count includes only the resolvers and appsync functions under API category that will be touched. In addition to that, there could be resources under a different category and several read operations count towards the 2500 CFN limit.');
};

const compareResolvers = (before: any, after: any) => {
    const beforeResolvers = before.RESOLVERS_RESOURCES;
    const afterResolvers = after.RESOLVERS_RESOURCES;

    const beforeKeys = Object.keys(beforeResolvers);
    const afterKeys = Object.keys(afterResolvers);

    const addedResolvers = afterKeys.filter(key => !beforeKeys.includes(key));
    const removedResolvers = beforeKeys.filter(key => !afterKeys.includes(key));
    const updatedResolvers = beforeKeys.filter(key => afterKeys.includes(key) && JSON.stringify(beforeResolvers[key]) !== JSON.stringify(afterResolvers[key]));

    return (addedResolvers.length ?? 0) + (removedResolvers.length ?? 0) + (updatedResolvers.length ?? 0);
};

const compareFunctions = (before: any, after: any) => {
    const beforeFunctions = before.FUNCTIONS_RESOURCES;
    const afterFunctions = after.FUNCTIONS_RESOURCES;
    const beforeKeys = Object.keys(beforeFunctions);
    const afterKeys = Object.keys(afterFunctions);

    const removedFunctions = beforeKeys.filter(key => !afterKeys.includes(key));

    return (afterKeys.length ?? 0) + (removedFunctions.length ?? 0);
};

compareStacks();