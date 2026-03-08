#!/bin/zsh

# Claude Code Bedrock Setup Script
# This script configures environment variables and installs dependencies for Amazon Bedrock integration.

echo "🚀 Starting Claude Code Bedrock Setup..."

# 1. Check for AWS CLI
if ! command -v aws &> /dev/null; then
    echo "📦 AWS CLI not found. Installing via Homebrew..."
    brew install awscli
else
    echo "✅ AWS CLI is already installed."
fi

# 2. Configure Environment Variables in .zshrc
ZSHRC="$HOME/.zshrc"
echo "📝 Updating $ZSHRC with Bedrock configuration..."

# Avoid duplicate entries
if ! grep -q "CLAUDE_CODE_USE_BEDROCK" "$ZSHRC"; then
    cat >> "$ZSHRC" << 'EOF'

# --- Claude Code Bedrock Configuration ---
export CLAUDE_CODE_USE_BEDROCK=1
export AWS_REGION=us-east-1
export ANTHROPIC_DEFAULT_SONNET_MODEL='us.anthropic.claude-sonnet-4-6'
export ANTHROPIC_DEFAULT_HAIKU_MODEL='us.anthropic.claude-haiku-4-5-20251001-v1:0'
export ANTHROPIC_DEFAULT_OPUS_MODEL='us.anthropic.claude-opus-4-6-v1'
# -----------------------------------------
EOF
    echo "✅ Configuration appended to $ZSHRC."
else
    echo "ℹ️ Bedrock configuration already exists in $ZSHRC."
fi

# 3. Final Instructions
echo "\n✨ Setup Complete!"
echo "--------------------------------------------------------"
echo "Next Steps:"
echo "1. Run 'source ~/.zshrc' or restart your terminal."
echo "2. Run 'aws configure' to set your AWS Access Key ID and Secret Access Key."
echo "3. Run 'claude' to start using Claude Code with Bedrock."
echo "--------------------------------------------------------"
