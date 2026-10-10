# Flujo para agentes

1. Usa `list_tickets` para elegir un ticket pendiente. Los urgentes aparecen primero.
2. Usa `get_ticket` para leer el detalle y obtener `workspacePath`.
3. Si `workspacePath` está vacío, no modifiques archivos y pide que se configure la ruta.
4. Usa `start_ticket` antes de editar. Trabaja únicamente dentro de `workspacePath`.
5. Reproduce el problema, realiza el cambio y ejecuta verificaciones adecuadas.
6. Usa `update_ticket_status` con `Revisión` si necesita validación humana.
7. Usa `resolve_ticket` solamente cuando el trabajo esté terminado. Incluye un resumen de cambios y pruebas.
