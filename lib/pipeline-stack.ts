import codebuild = require('@aws-cdk/aws-codebuild');
import codepipeline = require('@aws-cdk/aws-codepipeline');
import codepipeline_actions = require('@aws-cdk/aws-codepipeline-actions');
import * as cdk from '@aws-cdk/core';
import * as kms from '@aws-cdk/aws-kms';
import * as s3 from '@aws-cdk/aws-s3';
import { APIGWStack } from './agigw-stack';
import { DeployCdkStackAction } from "./deploy-cdk-stack-action";
import { DDBStack } from "./ddb-stack";

export interface PipelineStackProps extends cdk.StackProps {
  readonly ddbStack: DDBStack;
  readonly apiGwStack: APIGWStack;
}

export class PipelineStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    // allow customizing the SecretsManager GitHub token name
    // (needed for the GitHub source action)
    const gitHubTokenSecretName = process.env.GITHUB_TOKEN || 'my-github-token';

    // remove the pipeline's key & bucket, to not leave trash in the account
    const pipelineKey = new kms.Key(this, 'PipelineKey', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const pipelineBucket = new s3.Bucket(this, 'PipelineBucket', {
      encryptionKey: pipelineKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const sourceOutput = new codepipeline.Artifact();
    const cdkBuildOutput = new codepipeline.Artifact();
    // this is the artifact that will record the output containing the generated URL of the API Gateway
    const apiGwStackOutputs = new codepipeline.Artifact();

    new codepipeline.Pipeline(this, 'Pipeline', {
      restartExecutionOnUpdate: true,
      artifactBucket: pipelineBucket,
      pipelineName: 'MeerkatsPipeline',
      stages: [
        {
          stageName: 'Source',
          actions: [
            new codepipeline_actions.GitHubSourceAction({
              actionName: 'Source_GitHub',
              output: sourceOutput,
              oauthToken: cdk.SecretValue.secretsManager(gitHubTokenSecretName),
              owner: 'NetaNir',
              repo: 'meerkats',
              trigger: codepipeline_actions.GitHubTrigger.POLL,
            }),
          ],
        },
        {
          stageName: 'Build',
          actions: [
            new codepipeline_actions.CodeBuildAction({
              actionName: 'Build_CodeBuild',
              project: new codebuild.PipelineProject(this, 'Build', {
                buildSpec: codebuild.BuildSpec.fromObject({
                  version: '0.2',
                  phases: {
                    install: {
                      commands: 'npm install',
                    },
                    build: {
                      commands: 'npm run cdk synth',
                    },
                  },
                  // save the generated files in the output artifact
                  artifacts: {
                    'base-directory': 'cdk.out',
                    files: '**/*',
                  },
                }),
              }),
              input: sourceOutput,
              outputs: [cdkBuildOutput],
            }),
          ],
        },
        {
          stageName: 'Self_Mutation',
          actions: [
            new DeployCdkStackAction({
              baseActionName: 'Self_Mutate',
              input: cdkBuildOutput,
              stack: cdk.Stack.of(this),
            }),
          ],
        },
        {
          stageName: 'Deploy',
          actions: [
            // first, deploy the DynamoDB Stack
            new DeployCdkStackAction({
              baseActionName: 'Deploy_DynamoDB_Stack',
              input: cdkBuildOutput,
              stack: props.ddbStack,
            }),
            // then, deploy the API Gateway Stack
            new DeployCdkStackAction({
              baseActionName: 'Deploy_API_GW_Stack',
              input: cdkBuildOutput,
              stack: props.apiGwStack,
              output: apiGwStackOutputs,
              outputFileName: 'outputs.json',
              baseRunOrder: 3,
            }),
            // then, run an integration test
            new codepipeline_actions.CodeBuildAction({
              actionName: 'Integ_Test',
              input: apiGwStackOutputs,
              runOrder: 5,
              project: new codebuild.PipelineProject(this, 'IntegTestProject', {
                buildSpec: codebuild.BuildSpec.fromObject({
                  version: '0.2',
                  phases: {
                    build: {
                      commands: [
                        'set -e',
                        // take out the URL of the API Gateway from the outputs.json file produced by the previous CFN deploy Action
                        `api_gw_url=$(node -e 'console.log(require("./outputs.json")["${APIGWStack.URL_OUTPUT}"]);')`,
                        'curl $api_gw_url',
                      ],
                    },
                  },
                }),
              }),
            }),
          ],
        },
      ],
    });
  }
}
