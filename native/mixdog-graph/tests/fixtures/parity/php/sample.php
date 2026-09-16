<?php
// Parity fixture: declaration and import shapes the graph reports for PHP.
namespace App\Sample;

use App\Models\User;
use App\Models\{Post, Comment};
use App\Contracts\Storage as StorageContract;

require_once __DIR__ . '/bootstrap.php';
require 'helpers.php';

interface Storage
{
    public function read(string $key): string;
}

trait Loggable
{
    public function log(string $message): void
    {
        error_log($message);
    }
}

enum Mode: string
{
    case Fast = 'fast';
    case Slow = 'slow';

    public function label(): string
    {
        return ucfirst($this->value);
    }
}

class Store implements Storage
{
    use Loggable;

    private string $name;

    public function __construct(string $name)
    {
        $this->name = $name;
    }

    public function read(string $key): string
    {
        return $this->name . ':' . $key;
    }

    private static function build(string $name): self
    {
        return new self($name);
    }
}

function top_level(User $user, StorageContract $storage): string
{
    return $storage->read((string) $user->id) . Post::class . Comment::class;
}
