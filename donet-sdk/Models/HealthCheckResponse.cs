using System.Text.Json.Serialization;

namespace MmnDotNetSdk.Models
{
    /// <summary>
    /// Response from health check operation
    /// </summary>
    public class HealthCheckResponse
    {
        [JsonPropertyName("status")]
        public string Status { get; set; } = string.Empty;
        
        [JsonPropertyName("timestamp")]
        public long Timestamp { get; set; }
        
        [JsonPropertyName("message")]
        public string Message { get; set; } = string.Empty;
        
        [JsonPropertyName("version")]
        public string Version { get; set; } = string.Empty;
    }
}
