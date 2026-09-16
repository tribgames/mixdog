# Parity fixture: declaration and import shapes the graph reports for Ruby.
require 'json'
require_relative 'helper'

module Acme
  LIMIT = 10

  class Store
    attr_reader :name

    def initialize(name)
      @name = name
    end

    def read(key)
      JSON.generate(name: @name, key: key)
    end

    def name=(value)
      @name = value
    end

    def self.build(name)
      new(name)
    end

    class Inner
      def ping
        :pong
      end
    end
  end

  def self.helper
    Store.build('helper')
  end
end

def top_level(value)
  value.to_s
end
