output "config_files" {
  description = "Paths to generated OpenBao server configs"
  value       = [for f in local_file.openbao_config : f.filename]
}

output "docker_compose_file" {
  description = "Path to generated HA docker-compose file"
  value       = local_file.docker_compose_ha.filename
}
