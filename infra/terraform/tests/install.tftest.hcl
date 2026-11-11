mock_provider "aws" {}

variables {
  release = {
    version        = "0.2.0"
    bucket         = "kieli-fixture-artifacts"
    key            = "releases/0.2.0/kieli-fixture.zip"
    object_version = "fixture-immutable-version"
  }
}

run "zip_install" {
  command = plan
  assert {
    condition     = local.template.Resources.App.Properties.Handler == "run.sh" && local.template.Resources.App.Properties.Runtime == "nodejs24.x"
    error_message = "The installer must use the Node ZIP runner."
  }
  assert {
    condition     = local.template.Resources.App.Properties.Environment.Variables.KIELI_VERSION == "0.2.0" && local.template.Mappings.ReleaseArtifacts["eu-west-1"].ObjectVersion == "fixture-immutable-version"
    error_message = "Terraform must replace the version and immutable artifact mapping."
  }
  assert {
    condition     = local.template.Resources.Data.Properties.KeySchema[0].AttributeName == "pk" && local.template.Resources.Data.Properties.KeySchema[1].AttributeName == "sk" && local.template.Resources.Data.DeletionPolicy == "Retain"
    error_message = "Preserve Kieli's retained DynamoDB model."
  }
}

run "regional_saml_configuration" {
  command = plan
  variables {
    region = "us-east-1"
    parameters = {
      AuthMode       = "saml"
      AppSecretsArn  = "arn:aws:secretsmanager:us-east-1:123456789012:secret:fixture"
      SamlEntryPoint = "https://idp.example.test/sso"
      SamlIdpIssuer  = "https://idp.example.test/entity"
    }
  }
  assert {
    condition     = local.template.Mappings.ReleaseArtifacts["us-east-1"].Bucket == "kieli-fixture-artifacts" && !contains(keys(local.template.Mappings.ReleaseArtifacts), "eu-west-1")
    error_message = "Artifact coordinates must use only the chosen region."
  }
}

run "reject_unversioned_artifact" {
  command = plan
  variables {
    release = {
      version        = "0.2.0"
      bucket         = "kieli-fixture-artifacts"
      key            = "releases/fixture.zip"
      object_version = "null"
    }
  }
  expect_failures = [var.release]
}

run "reject_secret_value_parameter" {
  command = plan
  variables {
    parameters = { SESSION_SECRET = "synthetic-not-a-real-secret" }
  }
  expect_failures = [var.parameters]
}
