import * as cdk from 'aws-cdk-lib';

import { MazeStack } from './maze-stack';

const ACCOUNT = process.env.CDK_DEPLOY_ACCOUNT ?? process.env.CDK_DEFAULT_ACCOUNT ?? '504242000181';

const app = new cdk.App();

new MazeStack(app, 'StackMaze2adCom', {
  env: {
    account: ACCOUNT,
    region: 'us-east-1',
  },
});
