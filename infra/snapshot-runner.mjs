// This function is embedded in CloudFormation; Node Lambda supplies the AWS SDK.
export const runnerCode = `
const {SecretsManagerClient,GetSecretValueCommand}=require('@aws-sdk/client-secrets-manager');
const {LambdaClient,InvokeCommand}=require('@aws-sdk/client-lambda');
const secrets=new SecretsManagerClient({}); const lambda=new LambdaClient({});
exports.handler=async()=>{
  const secret=await secrets.send(new GetSecretValueCommand({SecretId:process.env.JOB_SECRET}));
  if(!secret.SecretString||secret.SecretString.length<32) throw Error('Job secret unavailable');
  const event={version:'2.0',routeKey:'POST /tasks/snapshots',rawPath:'/tasks/snapshots',rawQueryString:'',headers:{host:'internal.keylo',authorization:'Bearer '+secret.SecretString,'content-type':'application/json'},requestContext:{accountId:'internal',apiId:'internal',domainName:'internal.keylo',domainPrefix:'internal',http:{method:'POST',path:'/tasks/snapshots',protocol:'HTTP/1.1',sourceIp:'127.0.0.1',userAgent:'keylo-snapshot-runner'},requestId:'snapshot-job',routeKey:'POST /tasks/snapshots',stage:'$default',time:'',timeEpoch:Date.now()},body:'{}',isBase64Encoded:false};
  const response=await lambda.send(new InvokeCommand({FunctionName:process.env.APP_FUNCTION,InvocationType:'RequestResponse',Payload:Buffer.from(JSON.stringify(event))}));
  if(response.FunctionError) throw Error('Snapshot job invocation failed');
  const output=JSON.parse(Buffer.from(response.Payload).toString());
  if(output.statusCode!==200) throw Error('Snapshot job returned an error');
  const body=JSON.parse(output.isBase64Encoded?Buffer.from(output.body,'base64').toString():output.body);
  if(body.status==='partial-failure') throw Error('Some project snapshots failed; retry on next schedule');
  return {status:body.status};
};`;
export function snapshotResources() {
  const ref = (name) => ({ Ref: name }),
    attr = (name, key) => ({ "Fn::GetAtt": [name, key] });
  return {
    SnapshotJobSecret: {
      Type: "AWS::SecretsManager::Secret",
      Properties: {
        Description: "Keylo internal snapshot job credential",
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
            PolicyName: "RunKeyloSnapshots",
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
          },
        },
      },
    },
    SnapshotSchedule: {
      Type: "AWS::Events::Rule",
      Properties: {
        Description: "Keylo snapshot scheduler and abandoned-data cleanup",
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
