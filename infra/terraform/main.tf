terraform {
  required_version = ">= 1.7.0, < 2.0.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.region
}

variable "region" {
  type    = string
  default = "eu-west-1"
  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]+$", var.region))
    error_message = "Use the commercial AWS region containing the release bucket."
  }
}

variable "name" {
  type    = string
  default = "kieli"
}

variable "release" {
  description = "Verified Linux x64/glibc ZIP in a versioned S3 bucket in the selected region."
  type = object({
    version        = string
    bucket         = string
    key            = string
    object_version = string
  })
  validation {
    condition = (
      can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+(-[a-zA-Z0-9.-]+)?$", var.release.version)) &&
      can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.release.bucket)) &&
      startswith(var.release.key, "releases/") &&
      length(var.release.object_version) > 0 && var.release.object_version != "null"
    )
    error_message = "Supply a versioned release ZIP, including a non-null S3 object version."
  }
}

variable "parameters" {
  description = "Installer parameters. Supply secret ARNs only, never secret values."
  type        = map(string)
  default     = { AuthMode = "local" }
  validation {
    condition = alltrue([for key in keys(var.parameters) : contains([
      "AuthMode", "AppOrigin", "ReservedConcurrency", "AppSecretsArn", "OktaIssuer", "OktaClientId",
      "SamlEntryPoint", "SamlLogoutUrl", "SamlIdpIssuer", "SamlSpEntityId", "SecretsRevision",
      "SsoProvisioningMode", "ScimSecretArn", "ReconciliationSecretArn"
    ], key)])
    error_message = "Only documented installer parameters are accepted; credentials must remain in Secrets Manager."
  }
}

locals {
  base_template = jsondecode(file("${path.module}/.generated/install.json"))
  template = merge(local.base_template, {
    Description = "Kieli ${var.release.version}: ZIP Lambda installation managed through Terraform."
    Metadata = merge(local.base_template.Metadata, {
      KieliRelease = { version = var.release.version, region = var.region, artifact = var.release.key }
    })
    Mappings = merge(local.base_template.Mappings, {
      ReleaseArtifacts = {
        (var.region) = { Bucket = var.release.bucket, Key = var.release.key, ObjectVersion = var.release.object_version }
      }
    })
    Resources = merge(local.base_template.Resources, {
      App = merge(local.base_template.Resources.App, {
        Properties = merge(local.base_template.Resources.App.Properties, {
          Environment = { Variables = merge(local.base_template.Resources.App.Properties.Environment.Variables, {
            KIELI_VERSION = var.release.version
          }) }
        })
      })
    })
  })
}

# Keep the existing ZIP installer as the single infrastructure definition.
# Terraform owns the stack; CloudFormation owns the resources inside it.
resource "aws_cloudformation_stack" "kieli" {
  name          = var.name
  template_body = jsonencode(local.template)
  parameters    = var.parameters
  capabilities  = ["CAPABILITY_IAM"]
  lifecycle {
    prevent_destroy = true
  }
}

output "installation" {
  description = "Installer outputs, including application URL and first-run secret ARN (never its value)."
  value       = aws_cloudformation_stack.kieli.outputs
}
