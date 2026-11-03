// This function is embedded in CloudFormation; Node Lambda supplies the AWS SDK.
export const runnerCode = `
const {SecretsManagerClient,GetSecretValueCommand}=require('@aws-sdk/client-secrets-manager');
const {LambdaClient,InvokeCommand}=require('@aws-sdk/client-lambda');
const secrets=new SecretsManagerClient({}); const lambda=new LambdaClient({});
exports.handler=async()=>{
  const secret=await secrets.send(new GetSecretValueCommand({SecretId:process.env.JOB_SECRET}));
  if(!secret.SecretString||secret.SecretString.length<32) throw Error('Job secret unavailable');
  async function invoke(path) {
    const event={version:'2.0',routeKey:'POST '+path,rawPath:path,rawQueryString:'',headers:{host:'internal.kieli',authorization:'Bearer '+secret.SecretString,'content-type':'application/json'},requestContext:{accountId:'internal',apiId:'internal',domainName:'internal.kieli',domainPrefix:'internal',http:{method:'POST',path,protocol:'HTTP/1.1',sourceIp:'127.0.0.1',userAgent:'kieli-maintenance-runner'},requestId:'maintenance-job',routeKey:'POST '+path,stage:'$default',time:'',timeEpoch:Date.now()},body:'{}',isBase64Encoded:false};
    const response=await lambda.send(new InvokeCommand({FunctionName:process.env.APP_FUNCTION,InvocationType:'RequestResponse',Payload:Buffer.from(JSON.stringify(event))}));
    if(response.FunctionError) throw Error('Maintenance invocation failed');
    const output=JSON.parse(Buffer.from(response.Payload).toString());
    if(output.statusCode!==200) throw Error('Maintenance returned an error');
    const body=JSON.parse(output.isBase64Encoded?Buffer.from(output.body,'base64').toString():output.body);
    if(body.status==='partial-failure') throw Error('Maintenance partially failed; retry on next schedule');
    return body.status;
  }
  const paths=['/tasks/snapshots'];
  if(process.env.RECONCILE_ENABLED==='true') paths.push('/tasks/identities');
  const results=await Promise.allSettled(paths.map(invoke));
  if(results.some(result=>result.status==='rejected')) throw Error('Maintenance failed');
  return {status:'ok'};
};`;
export function snapshotResources() {
  const ref = (name) => ({ Ref: name }),
    attr = (name, key) => ({ "Fn::GetAtt": [name, key] });
  return {
    SnapshotJobSecret: {
      Type: "AWS::SecretsManager::Secret",
      Properties: {
        Description: "Kieli internal snapshot job credential",
        GenerateSecretString: {
          PasswordLength: 48,
          ExcludePunctuation: true,
          IncludeSpace: false,
          RequireEachIncludedType: false,
        },
      },
    },
    SnapshotRunnerLogs: {
      Type: "AWS::Logs::LogGroup",
      Properties: { RetentionInDays: 14 },
    },
    SnapshotRunnerRole: {
      Type: "AWS::IAM::Role",
      Properties: {
        AssumeRolePolicyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "lambda.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        },
        Policies: [
          {
            PolicyName: "RunKieliSnapshots",
            PolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Action: "secretsmanager:GetSecretValue",
                  Resource: ref("SnapshotJobSecret"),
                },
                {
                  Effect: "Allow",
                  Action: "lambda:InvokeFunction",
                  Resource: attr("App", "Arn"),
                },
                {
                  Effect: "Allow",
                  Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
                  Resource: attr("SnapshotRunnerLogs", "Arn"),
                },
              ],
            },
          },
        ],
      },
    },
    SnapshotRunner: {
      Type: "AWS::Lambda::Function",
      Properties: {
        Runtime: "nodejs24.x",
        Handler: "index.handler",
        MemorySize: 128,
        Timeout: 40,
        Role: attr("SnapshotRunnerRole", "Arn"),
        LoggingConfig: { LogGroup: ref("SnapshotRunnerLogs") },
        Code: { ZipFile: runnerCode },
        Environment: {
          Variables: {
            JOB_SECRET: ref("SnapshotJobSecret"),
            APP_FUNCTION: ref("App"),
            RECONCILE_ENABLED: {
              "Fn::If": ["HasSsoReconciliation", "true", "false"],
            },
          },
        },
      },
    },
    SnapshotSchedule: {
      Type: "AWS::Events::Rule",
      Properties: {
        Description: "Kieli snapshot scheduler and abandoned-data cleanup",
        ScheduleExpression: "rate(5 minutes)",
        State: "ENABLED",
        Targets: [
          {
            Arn: attr("SnapshotRunner", "Arn"),
            Id: "Snapshots",
            RetryPolicy: {
              MaximumRetryAttempts: 2,
              MaximumEventAgeInSeconds: 300,
            },
          },
        ],
      },
    },
    SnapshotInvokePermission: {
      Type: "AWS::Lambda::Permission",
      Properties: {
        FunctionName: ref("SnapshotRunner"),
        Action: "lambda:InvokeFunction",
        Principal: "events.amazonaws.com",
        SourceArn: attr("SnapshotSchedule", "Arn"),
        SourceAccount: ref("AWS::AccountId"),
      },
    },
  };
}
