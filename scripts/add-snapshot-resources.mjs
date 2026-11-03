// Keep the SAM image template's scheduler identical to the ZIP installer.
import {readFile,writeFile} from 'node:fs/promises';
import {stringify} from 'yaml';
import {snapshotResources} from '../infra/snapshot-runner.mjs';
const path=new URL('../infra/template.yaml',import.meta.url);
let text=await readFile(path,'utf8');
if(!text.includes('  SnapshotJobSecret:')) {
  const block=stringify(snapshotResources()).split('\n').filter(Boolean).map(line=>'  '+line).join('\n')+'\n';
  text=text.replace('Resources:\n','Resources:\n'+block);
  text=text.replace('          DYNAMODB_TABLE: !Ref Data','          DYNAMODB_TABLE: !Ref Data\n          KIELI_SNAPSHOT_JOB_SECRET_ARN: !Ref SnapshotJobSecret');
  text=text.replace('        - PolicyName: KieliDataAndLogs','        - PolicyName: KieliSnapshotSecret\n          PolicyDocument:\n            Version: "2012-10-17"\n            Statement:\n              - Effect: Allow\n                Action: secretsmanager:GetSecretValue\n                Resource: !Ref SnapshotJobSecret\n        - PolicyName: KieliDataAndLogs');
  await writeFile(path,text);
}
